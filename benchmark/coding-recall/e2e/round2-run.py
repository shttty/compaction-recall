"""Authorized LME16 round2: immutable snapshots, native tools, durable retries."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

import run as common

HERE = Path(__file__).resolve().parent
e = common.e
judge = common.module('round2_judge', HERE / 'rejudge-v2.py')
omp = common.module('round2_omp_boundary', HERE / 'omp-rpc.py')
ARMS = ('pi-mainline-r1', 'pi-mainline-r2', 'pi-sqlite-a', 'pi-sqlite-b', 'omp-sqlite')
COMMITS = {'mainline': 'e21c6d39634c945bc68930ae7560f21e4dcc966d', 'sqlite': 'b049c39df5613bab29afecfda95e67e6e2300b3c'}
MAX_ATTEMPTS = 3
TIMEOUT_TEXT = re.compile(r'timed?\s*out|timeout|deadline', re.IGNORECASE)


def scope_command(command):
    return ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=14G', '-p', 'MemorySwapMax=0', *command]


def scope_env(env=None):
    result = dict(e.child_env() if env is None else env)
    # Resource manager connection only; the SDK strips these before host loading.
    for key in ('XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'):
        if key in os.environ:
            result[key] = os.environ[key]
    return result


def scoped_rpc(command, env, cwd, **kwargs):
    return e.rpc.run_rpc(scope_command(command), scope_env(env), cwd, **kwargs)


def frozen_json(path, value):
    if path.exists():
        if json.loads(path.read_text()) != value:
            raise ValueError('Frozen configuration changed: ' + str(path))
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        e.write_json(path, value)


def prepare(args):
    output, previous = args.output.resolve(), args.previous.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    old = json.loads((previous / 'manifest.json').read_text())
    if old.get('state') != 'complete' or old.get('identity', {}).get('dataset') != 'LME16-English':
        raise ValueError('Requires complete real native LME16 run')
    ids = common.module('round2_lme_ids', HERE / 'lme-run.py')
    if set(old['selected']) != set(ids.DEV + ids.HARD) or len(old['questions']) != 16:
        raise ValueError('Round2 must use the same exact sixteen questions')
    config = json.loads(args.config.read_text())
    config['judge'] = json.loads(args.sol_config.read_text())['judge']
    config['output_dir'] = str(output)
    if config['answer'] != old['identity']['config']['answer']:
        raise ValueError('Round2 answer model/profile/effort must remain identical')
    frozen_json(output / 'config.json', config)
    e.CONFIG, e.CONFIG_PATH = config, output / 'config.json'
    e.b = e.configuration.load_helper(Path(config['helper_path']), config)
    pins = json.loads(args.pins.read_text())
    for name, expected in COMMITS.items():
        pin = pins[name]
        if pin['commit'] != expected:
            raise ValueError('Unexpected plugin commit')
        for filename, digest in pin['runtimeClosureSha256'].items():
            if e.file_sha(Path(pin['path']) / filename) != digest:
                raise ValueError('Pinned plugin runtime bytes changed')
    snapshots = {}
    for key, saved in old['snapshots'].items():
        path = Path(saved['path'])
        if e.file_sha(path) != saved['sha256']:
            raise ValueError('Original compression snapshot changed')
        compactions = [row for row in common.transcript(path) if row.get('type') == 'compaction']
        if len(compactions) != 3 or any(not row.get('summary', '').strip() for row in compactions):
            raise ValueError('Round2 requires existing three-native-compaction snapshots')
        snapshots[key] = {'path': str(path), 'sha256': saved['sha256'], 'reused': True, 'originalReused': saved['reused']}
    if len(snapshots) != 32:
        raise ValueError('Requires the existing Pi and OMP snapshot pairs')
    blobs = output / 'omp-blobs'
    blobs.mkdir(mode=0o700, exist_ok=True)
    hashes = set()
    for key, meta in snapshots.items():
        if key.startswith('omp/'):
            hashes.update(omp.validate_session_blobs(meta['path'], previous / 'omp-blobs'))
    for digest in hashes:
        source, target = previous / 'omp-blobs' / digest, blobs / digest
        if target.exists():
            if e.file_sha(target) != digest:
                raise ValueError('Copied OMP frame bytes changed')
        else:
            shutil.copyfile(source, target); target.chmod(0o600)
    prior_v2 = json.loads((previous / 'judge-v2/manifest.json').read_text())
    judge_configs, judge_paths = {}, {}
    for label in ('luna', 'sol'):
        phase_config = {**config, 'judge': prior_v2['judges'][label], 'output_dir': str(output / 'judge-v2' / label)}
        Path(phase_config['output_dir']).mkdir(parents=True, exist_ok=True)
        path = output / 'judge-v2' / (label + '-config.json')
        frozen_json(path, phase_config)
        judge_configs[label], judge_paths[label] = phase_config, path
    sources = (Path(__file__), HERE / 'plugin.mjs', HERE / 'round2-tools.mjs', HERE / 'omp-rpc.py', HERE / 'omp-extension.mjs', HERE / 'run.py', HERE / 'pi-rpc.mjs',
               HERE / 'rejudge-v2.py', HERE / 'judge-v2.py', HERE / 'judge-pi-rpc.mjs', common.ROOT / 'benchmark/sdk-rpc.mjs', Path(e.__file__), Path(e.rpc.__file__), Path(config['helper_path']))
    identity = {'task': 'RSM-E2E-ROUND2-20261005', 'previous': str(previous), 'previousManifestSha256': e.file_sha(previous / 'manifest.json'),
                'pins': pins, 'config': config, 'judgeConfigs': judge_configs,
                'sources': {str(path): e.file_sha(path) for path in sources},
                'inputs': {str(path): e.file_sha(path) for path in (args.config, args.sol_config, args.pins)},
                'questions': old['questions'], 'snapshots': snapshots, 'arms': list(ARMS),
                'snippetPolicy': {'pi-mainline-r1': 'native120', 'pi-mainline-r2': 'native120', 'pi-sqlite-a': 'default120-codepoints', 'pi-sqlite-b': 'weighted240', 'omp-sqlite': 'default120-codepoints'},
                'toolWording': 'native registered descriptions and parameter descriptions; no v7 override',
                'maxSessions': 16, 'attempts': MAX_ATTEMPTS, 'retryPolicy': 'provider/model-error only; preserve each attempt; delays 2 then 4 seconds',
                'resourceScope': {'MemoryMax': '14G', 'MemorySwapMax': 0, 'boundary': 'each answer or judge process tree'}}
    fingerprint = e.object_sha(identity)
    path = output / 'manifest.json'
    if path.exists():
        manifest = json.loads(path.read_text())
        if manifest['fingerprint'] != fingerprint:
            raise ValueError('Round2 frozen inputs/configuration/runtime changed; refusing resume')
    else:
        manifest = {'fingerprint': fingerprint, 'identity': identity, 'questions': old['questions'], 'selected': old['selected'], 'snapshots': snapshots,
                    'arms': list(ARMS), 'state': 'prepared', 'preflight': {}, 'hostPhases': {}}
        e.write_json(path, manifest)
    return output, config, pins, manifest, judge_configs, judge_paths


def source_snapshot(manifest, arm, qid):
    return Path(manifest['snapshots'][('omp/' if arm == 'omp-sqlite' else 'pi/') + qid]['path'])


def wrapper(directory, arm, pin, config, evidence, expected=None, stop=False):
    directory.mkdir(parents=True, exist_ok=True)
    entry = directory / 'entry.mjs'
    options = {'evidencePath': str(evidence), 'expectedPath': str(expected) if expected else None, 'stopAfterSerialization': stop}
    settings = {'entry': str(Path(pin['path']) / pin['entry']), 'sdkPath': config['sdk_path'], 'sqlite': arm not in ARMS[:2]}
    snippet = "process.env.COMPACTION_RECALL_SNIPPET_BUDGET = '240';" if arm == 'pi-sqlite-b' else 'delete process.env.COMPACTION_RECALL_SNIPPET_BUDGET;'
    content = (f"import {{ registerPinned }} from {json.dumps(str(HERE / 'plugin.mjs'))};\n"
               f"import {{ withToolEvidence }} from {json.dumps(str(HERE / 'round2-tools.mjs'))};\n"
               f"export default async pi => {{ {snippet} await registerPinned(withToolEvidence(pi, {json.dumps(options)}), {json.dumps(settings)}); }};\n")
    if entry.exists() and entry.read_text() != content:
        raise ValueError('Generated native-tool wrapper changed')
    if not entry.exists(): entry.write_text(content)
    frozen_json(directory / 'package.json', {'type': 'module', 'pi': {'extensions': ['./entry.mjs']}})
    entry.chmod(0o444); (directory / 'package.json').chmod(0o444)
    return directory


def answer_command(output, config, pins, arm, folder, session, evidence, expected=None, stop=False):
    system = folder / 'answer-system.txt'
    pin = pins['mainline' if arm in ARMS[:2] else 'sqlite']
    if arm == 'omp-sqlite':
        omp_config = {**config, 'tool_evidence': {'evidencePath': str(evidence), 'expectedPath': str(expected) if expected else None, 'stopAfterSerialization': stop}}
        config_path = folder / 'omp-config.json'
        frozen_json(config_path, omp_config)
        return ['python3', str(HERE / 'omp-rpc.py'), '--config', str(config_path), '--phase', 'answer', '--session', str(session), '--replay-policy', 'lme-native',
                '--plugin-entry', str(Path(pin['path']) / pin['entry']), '--timing-file', str(folder / 'timing.jsonl'), '--append-system-prompt', str(system)]
    extension = wrapper(folder / 'wrapper', arm, pin, config, evidence, expected, stop)
    return ['node', str(HERE / 'pi-rpc.mjs'), '--config', str(output / 'config.json'), '--phase', 'answer', '--session', str(session), '--arm', 'production',
            '--plugin-dir', str(extension), '--timing-file', str(folder / 'timing.jsonl'), '--append-system-prompt', str(system)]


def preflight(output, config, pins, manifest, *, arms=ARMS, command_factory=answer_command, expected_tool_count=3):
    if manifest['preflight']:
        if set(manifest['preflight']) != set(arms):
            raise ValueError('Incomplete serialization preflight refuses implicit replay')
        for evidence in manifest['preflight'].values():
            if e.file_sha(Path(evidence['path'])) != evidence['sha256']:
                raise ValueError('Serialized native tools changed')
        return
    described = subprocess.run(scope_command(['node', str(common.ROOT / 'benchmark/sdk-rpc.mjs'), '--config', str(output / 'config.json'), '--phase', 'answer', '--describe']),
                               env=scope_env(), capture_output=True, text=True)
    if described.returncode:
        raise RuntimeError('Answer model descriptor failed; provider detail omitted')
    manifest['answerDescriptor'] = json.loads(described.stdout)
    question = manifest['questions'][0]
    evidence = {}
    for arm in arms:
        folder = output / 'probe' / arm
        folder.mkdir(parents=True, exist_ok=True)
        session = folder / 'session.jsonl'
        if session.exists():
            raise ValueError('Prior serialization probe needs explicit disposition')
        shutil.copyfile(source_snapshot(manifest, arm, question['id']), session)
        (folder / 'answer-system.txt').write_text(common.answer_system_prompt(question))
        destination = output / 'tool-definitions' / (arm + '.json')
        destination.parent.mkdir(exist_ok=True)
        command = command_factory(output, config, pins, arm, folder, session, destination, stop=True)
        observed = scoped_rpc(command, e.child_env(), folder, prompt=question['question'], timeout=120)
        if observed['rc'] != 2 or not destination.is_file():
            raise RuntimeError('Actual host serialization evidence missing; no model calls authorized before all groups verified')
        actual = json.loads(destination.read_text())
        if actual.get('source') != 'before_provider_request' or actual.get('descriptionsPreserved') is not True or len(actual.get('serialized', [])) != expected_tool_count:
            raise ValueError('Host serialization did not preserve native three tools' if expected_tool_count == 3
                             else 'Host serialization did not preserve the expected native tools')
        evidence[arm] = {'path': str(destination), 'sha256': e.file_sha(destination), 'modelCalls': 0, 'stoppedBeforeNetwork': True}
    definitions = [json.loads(Path(evidence[arm]['path']).read_text())['serialized'] for arm in arms]
    if any(value != definitions[0] for value in definitions[1:]):
        raise ValueError('Paired tool definitions differ')
    manifest['preflight'] = evidence
    manifest['state'] = 'preflight-complete'
    e.write_json(output / 'manifest.json', manifest)


def tool_timeouts(record):
    if not record.get('session'):
        return 0
    path = Path(record['session'])
    snapshot = Path(record.get('snapshotPath', ''))
    if not path.is_file() or not snapshot.is_file():
        return 0
    suffix = path.read_bytes()[len(snapshot.read_bytes()):]
    rows = [json.loads(line) for line in suffix.decode().split('\n') if line]
    return sum(bool(row.get('message', {}).get('isError')) and bool(TIMEOUT_TEXT.search(json.dumps(row['message'].get('content', []))))
               for row in rows if row.get('message', {}).get('role') == 'toolResult')


def answer_attempt(output, config, pins, manifest, question, arm, folder, *, command_factory=answer_command):
    folder.mkdir(parents=True, exist_ok=True)
    snapshot = source_snapshot(manifest, arm, question['id'])
    identity = e.object_sha({'run': manifest['fingerprint'], 'tools': manifest['preflight'][arm]['sha256'], 'arm': arm, 'id': question['id'], 'attempt': folder.name})
    def operation():
        session = folder / 'session.jsonl'
        shutil.copyfile(snapshot, session)
        (folder / 'answer-system.txt').write_text(common.answer_system_prompt(question))
        expected = Path(manifest['preflight'][arm]['path'])
        command = command_factory(output, config, pins, arm, folder, session, folder / 'tools.json', expected)
        start = time.monotonic()
        try:
            observed = scoped_rpc(command, e.child_env(), folder, prompt=question['question'], timeout=900)
        except Exception as error:
            observed = {'outcome': 'provider-exception', 'rc': -1, 'timing': {}, 'stderr': ''}
        elapsed = (time.monotonic() - start) * 1000
        try:
            record = common.extract_answer(session, snapshot, observed, question, arm, elapsed)
        except Exception:
            record = {'arm': arm, 'question_id': question['id'], 'outcome': 'chain-error', 'answer': '', 'tool_calls': [], 'toolResults': [], 'tokens': None,
                      'session': str(session), 'sessionSha256': e.file_sha(session), 'snapshotSha256': e.file_sha(snapshot), 'answerWallMs': elapsed,
                      'metadata': {key: question.get(key) for key in ('caseId', 'subset', 'language', 'type', 'overlap')}}
        record.update(snapshotPath=str(snapshot), providerTimeout='timeout' in observed['outcome'], rpcOutcome=observed['outcome'], rc=observed['rc'])
        record['toolTimeoutErrors'] = tool_timeouts(record)
        evidence = folder / 'tools.json'
        if evidence.exists():
            record['toolsEvidence'] = {'path': str(evidence), 'sha256': e.file_sha(evidence)}
        elif record['outcome'] == 'answered':
            record['outcome'] = 'chain-error'
        return record
    return common.durable_phase(folder, 'answer', identity, operation)


def answer_one(output, config, pins, manifest, question, arm, *, command_factory=answer_command, stop_retry=None):
    directory = output / 'results' / arm / question['id']
    directory.mkdir(parents=True, exist_ok=True)
    identity = e.object_sha({'run': manifest['fingerprint'], 'tools': manifest['preflight'][arm]['sha256'], 'arm': arm, 'id': question['id']})
    def operation():
        attempts = []
        for number in range(1, MAX_ATTEMPTS + 1):
            saved = answer_attempt(output, config, pins, manifest, question, arm, directory / 'attempts' / f'{number:02d}', command_factory=command_factory)
            attempts.append(saved)
            if (stop_retry is not None and stop_retry(saved)) or saved['outcome'] != 'model-error' or number == MAX_ATTEMPTS:
                break
            time.sleep(2 ** number)
        record = dict(attempts[-1])
        record['attempts'] = [{**{key: value.get(key) for key in ('outcome', 'providerTimeout', 'toolTimeoutErrors', 'rc', 'session', 'sessionSha256', 'answerWallMs', 'tokens')},
                               'attempt': number + 1} for number, value in enumerate(attempts)]
        record['totalAttemptWallMs'] = sum(value['answerWallMs'] for value in attempts)
        record['totalAttemptTokens'] = {key: sum(value['tokens'][key] for value in attempts)
                                        if all(isinstance(value.get('tokens'), dict) and isinstance(value['tokens'].get(key), (int, float)) for value in attempts) else None
                                        for key in ('input', 'output', 'cacheRead', 'cacheWrite')}
        record['timeoutErrors'] = {'tool': sum(value['toolTimeoutErrors'] for value in attempts), 'provider': sum(value['providerTimeout'] for value in attempts)}
        record['recoveredProviderRetries'] = len(attempts) - 1 if record['outcome'] == 'answered' else 0
        return record
    record = common.durable_phase(directory, 'result', identity, operation)
    print(json.dumps({'arm': arm, 'id': question['id'], 'outcome': record['outcome'], 'attempts': len(record['attempts'])}), flush=True)
    return record


def judge_one(output, manifest, config_paths, configs, question, arm, answer, label, *, stop_retry=None):
    directory = output / 'judge-v2' / label / arm / question['id']
    directory.mkdir(parents=True, exist_ok=True)
    identity = e.object_sha({'run': manifest['fingerprint'], 'label': label, 'arm': arm, 'id': question['id'], 'answer': e.object_sha(answer)})
    def operation():
        if answer['outcome'] != 'answered':
            return {'question_id': question['id'], 'arm': arm, 'judgeName': label, 'status': 'answer-failure', 'verdict': None, 'answerOutcome': answer['outcome'], 'attempts': []}
        prompt = judge.contract.build_prompt(question['question'], question['answer'], answer['answer'], question['question_date'])
        item = {'question_id': question['id'], 'arm': arm, 'model_answer': answer['answer'], 'prompt': prompt,
                'inputSha256': e.object_sha({'prompt': prompt}), 'originalResultSha256': e.file_sha(output / 'results' / arm / question['id'] / 'result.json')}
        attempts = []
        for number in range(1, MAX_ATTEMPTS + 1):
            saved = judge.judge_one(item, label, config_paths[label], configs[label]['judge'], directory / 'attempts' / f'{number:02d}',
                                    manifest['fingerprint'] + '/' + str(number), rpc_runner=scoped_rpc)
            attempts.append(saved)
            if (stop_retry is not None and stop_retry(saved)) or saved['status'] != 'provider-error' or number == MAX_ATTEMPTS:
                break
            time.sleep(2 ** number)
        result = dict(attempts[-1])
        result['attempts'] = [{'attempt': number + 1, **{key: value.get(key) for key in ('status', 'failureKind', 'session', 'sessionSha256', 'seconds')}} for number, value in enumerate(attempts)]
        return result
    return common.durable_phase(directory, 'result', identity, operation)


def run(args):
    output, config, pins, manifest, judge_configs, judge_paths = prepare(args)
    preflight(output, config, pins, manifest)
    if args.stage == 'preflight':
        return manifest
    if args.stage in ('answers', 'all'):
        records = []
        with ThreadPoolExecutor(max_workers=16) as pool:
            jobs = [pool.submit(answer_one, output, config, pins, manifest, question, arm) for question in manifest['questions'] for arm in ARMS]
            for job in as_completed(jobs): records.append(job.result())
        e.write_json(output / 'answer-ledger.json', {'fingerprint': manifest['fingerprint'], 'records': records})
        manifest['hostPhases']['answers'] = 'complete'; manifest['state'] = 'answers-complete'
        e.write_json(output / 'manifest.json', manifest)
    if args.stage in ('judges', 'all'):
        if manifest['hostPhases'].get('answers') != 'complete':
            raise ValueError('Judges require completed answer phase')
        for label, path in judge_paths.items():
            description = subprocess.run(scope_command(['node', str(HERE / 'judge-pi-rpc.mjs'), '--config', str(path), '--phase', 'judge', '--describe']),
                                         env=scope_env(), capture_output=True, text=True)
            if description.returncode:
                raise RuntimeError('Requested judge tier was not resolved; provider detail omitted')
            manifest.setdefault('judgeDescriptors', {})[label] = json.loads(description.stdout)
        records = []
        with ThreadPoolExecutor(max_workers=16) as pool:
            jobs = []
            for question in manifest['questions']:
                for arm in ARMS:
                    answer = json.loads((output / 'results' / arm / question['id'] / 'result.json').read_text())
                    for label in ('luna', 'sol'):
                        jobs.append(pool.submit(judge_one, output, manifest, judge_paths, judge_configs, question, arm, answer, label))
            for job in as_completed(jobs): records.append(job.result())
        e.write_json(output / 'judge-v2/ledger.json', {'fingerprint': manifest['fingerprint'], 'records': records})
        manifest['hostPhases']['judges'] = 'complete'; manifest['state'] = 'complete'
        e.write_json(output / 'manifest.json', manifest)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('previous', 'output', 'config', 'sol-config', 'pins'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--stage', choices=('preflight', 'answers', 'judges', 'all'), default='all')
    run(parser.parse_args())
