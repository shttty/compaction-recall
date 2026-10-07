"""SDK answer commands, frozen wrappers, serialization proof, and token estimates."""
import json
from pathlib import Path
import shutil
import subprocess
from runner import artifacts as common
from runner import prepare as preparation

HERE = Path(__file__).resolve().parent.parent


def plain_rpc(command, env, directory, **kwargs):
    observed = common.rpc.run_rpc(command, env, directory, collect_memory=True, **kwargs)
    common.write_json(Path(directory) / 'process-memory.json', observed.get('memory'))
    return observed


def package_command(output, config, pins, folder, session, *, phase='answer', home=None, evidence=None, expected=None, stop=False, offline=False):
    command = ['node']
    if offline or phase == 'compression' or stop:
        command.extend(['--import', str(HERE / 'sdk/no-network.mjs')])
    command.extend([str(HERE / 'sdk/package.mjs'), '--config', str(output / 'config.json'), '--phase', phase,
                    '--session', str(session), '--arm', 'package', '--plugin-dir', pins['package']['path'],
                    '--home', str(home)])
    if phase == 'answer':
        command.extend(['--append-system-prompt', str(folder / 'answer-system.txt')])
        if evidence:
            command.extend(['--tool-evidence', str(evidence)])
        if expected:
            command.extend(['--expected-tools', str(expected)])
        if stop:
            command.append('--stop-after-serialization')
    return command


def answer_command(output, config, pins, arm, folder, session, evidence, expected=None, stop=False):
    if arm == 'package':
        qid = folder.parents[1].name
        return package_command(output, config, pins, folder, session, home=output / 'homes' / qid,
                               evidence=evidence, expected=expected, stop=stop)
    command = ['node', str(HERE / 'sdk/answer.mjs'), '--config', str(output / 'config.json'), '--phase', 'answer',
               '--session', str(session), '--append-system-prompt', str(folder / 'answer-system.txt')]
    if arm == 'pi-native':
        command.extend(['--arm', 'native', '--tool-evidence', str(evidence)])
        if expected:
            command.extend(['--expected-tools', str(expected)])
        if stop:
            command.append('--stop-after-serialization')
        return command
    directory = folder / 'wrapper'
    directory.mkdir(parents=True, exist_ok=True)
    pin = pins['sqlite']
    settings = {'entry': str(Path(pin['path']) / pin['entry']), 'sdkPath': config['sdk_path'],
                'runtimeEvidencePath': str(folder / 'sdk-registration.json')}
    options = {'evidencePath': str(evidence), 'expectedPath': str(expected) if expected else None, 'stopAfterSerialization': stop}
    if arm == 'pi-lite':
        options['expectedTools'] = ['history_expand', 'history_grep']
    context = {'directory': str(folder), 'toolsOnly': arm == 'pi-lite'}
    content = (f"import {{ registerPinned }} from {json.dumps(str(HERE / 'sdk/extension.mjs'))};\n"
               f"import {{ withToolEvidence }} from {json.dumps(str(HERE / 'sdk/tools-evidence.mjs'))};\n"
               f"import {{ withContextEvidence }} from {json.dumps(str(HERE / 'sdk/context-evidence.mjs'))};\n"
               f"export default async pi => {{ "
               f"await registerPinned(withToolEvidence(withContextEvidence(pi, {json.dumps(context)}), {json.dumps(options)}), {json.dumps(settings)}); }};\n")
    entry = directory / 'entry.mjs'
    if entry.exists() and entry.read_text() != content:
        raise ValueError('Frozen answer wrapper changed')
    if not entry.exists():
        entry.write_text(content)
    preparation.frozen_json(directory / 'package.json', {'type': 'module', 'pi': {'extensions': ['./entry.mjs']}})
    entry.chmod(0o444); (directory / 'package.json').chmod(0o444)
    command.extend(['--arm', 'production', '--plugin-dir', str(directory), '--timing-file', str(folder / 'timing.jsonl')])
    if arm in ('pi-lite', 'pi-full'):
        command.extend(['--recall-config', str(output / 'recall-config.json')])
    return command


def serialization(output, config, pins, manifest, *, rpc_runner=None):
    arm = manifest['arms'][0]
    if arm == 'package':
        return package_serialization(output, config, pins, manifest, rpc_runner=rpc_runner)
    folder = output / 'serialization'
    folder.mkdir(exist_ok=True)
    identity = common.object_sha({'run': manifest['fingerprint'], 'arm': arm})
    def operation():
        source = folder / 'session.jsonl'
        source.write_text(json.dumps({'type': 'session', 'version': 3, 'id': 'offline-synthetic'}) + '\n')
        (folder / 'answer-system.txt').write_text('Inspect synthetic tool serialization only.')
        evidence = folder / 'tools.json'
        descriptors = {}
        for label, path, script, phase in (
            ('answer', output / 'config.json', common.ROOT / 'benchmark/sdk/session.mjs', 'answer'),
            *[(label, output / 'judge-v2' / (label + '-config.json'), HERE / 'sdk/judge.mjs', 'judge') for label in preparation.LABELS]):
            process = subprocess.run(['node', str(script), '--config', str(path), '--phase', phase, '--describe'],
                                     env=common.child_env(), capture_output=True, text=True)
            if process.returncode:
                raise RuntimeError('Explicit model descriptor failed: ' + label)
            descriptors[label] = json.loads(process.stdout)
        command = answer_command(output, config, pins, arm, folder, source, evidence, stop=True)
        observed = (rpc_runner or common.rpc.run_rpc)(command, common.child_env(), folder, prompt='Inspect synthetic tool serialization only.', timeout=120)
        if observed['rc'] != 2 or not evidence.is_file():
            raise RuntimeError('Actual SDK serialization must stop before network')
        actual = json.loads(evidence.read_text())
        expected = [] if arm == 'pi-native' else ['history_expand', 'history_grep'] if arm == 'pi-lite' else ['history_expand', 'history_grep', 'history_recall']
        if actual.get('source') != 'before_provider_request' or actual.get('descriptionsPreserved') is not True or [tool['name'] for tool in actual.get('serialized', [])] != expected:
            raise ValueError('Actual SDK serialized tools differ from current mode')
        return {'path': str(evidence), 'sha256': common.sha(evidence), 'modelCalls': 0,
                'stoppedBeforeNetwork': True, 'descriptors': descriptors}
    result = common.durable_phase(folder, 'result', identity, operation)
    preparation.verify_files({result['path']: result['sha256']}, 'Serialized native tools')
    manifest['toolEvidence'] = {arm: {k: result[k] for k in ('path', 'sha256', 'modelCalls', 'stoppedBeforeNetwork')}}
    manifest['answerDescriptor'] = result['descriptors']['answer']
    manifest['descriptors'] = {label: result['descriptors'][label] for label in preparation.LABELS}
    if manifest['state'] == 'prepared':
        manifest['state'] = 'serialization-complete'
    common.write_json(output / 'manifest.json', manifest)



def describe_models(output, config):
    descriptors = {}
    for label, path, script, phase in (
        ('answer', output / 'config.json', HERE / 'sdk/session.mjs', 'answer'),
        *[(label, output / 'judge-v2' / (label + '-config.json'), HERE / 'sdk/judge.mjs', 'judge') for label in preparation.LABELS]):
        process = subprocess.run(['node', str(script), '--config', str(path), '--phase', phase, '--describe'],
                                 env=common.child_env(), capture_output=True, text=True)
        if process.returncode:
            raise RuntimeError('Explicit model descriptor failed: ' + label)
        descriptors[label] = json.loads(process.stdout)
    return descriptors


def package_serialization(output, config, pins, manifest, *, rpc_runner=None):
    from runner import compression
    descriptors = describe_models(output, config)
    manifest['answerDescriptor'] = descriptors['answer']
    manifest['descriptors'] = {label: descriptors[label] for label in preparation.LABELS}
    first = None
    for question in manifest['questions']:
        qid = question['id']
        snapshot = compression.compress(output, config, pins, manifest, question, rpc_runner=rpc_runner)
        folder = output / 'serialization' / qid
        folder.mkdir(parents=True, exist_ok=True)
        identity = common.object_sha({'run': manifest['fingerprint'], 'qid': qid, 'snapshot': snapshot['sha256']})
        def operation():
            original_home, home = output / 'homes' / qid, folder / 'home'
            original_home.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copytree(original_home, home)
            session = folder / 'session.jsonl'
            shutil.copyfile(snapshot['path'], session)
            (folder / 'answer-system.txt').write_text(common.answer_system_prompt(question))
            evidence = folder / 'tools.json'
            command = package_command(output, config, pins, folder, session, home=home, evidence=evidence,
                                      expected=Path(first['path']) if first else None, stop=True)
            observed = (rpc_runner or plain_rpc)(command, common.child_env(), folder, prompt=question['question'], timeout=120)
            if observed['rc'] != 2 or 'ROUND2_STOP_AFTER_SERIALIZATION' not in observed['stderr'] or not evidence.is_file():
                raise RuntimeError('Package serialization must stop before network; inspect preflight evidence')
            actual = json.loads(evidence.read_text())
            if actual.get('source') != 'before_provider_request':
                raise ValueError('Package tool serialization evidence missing')
            return {'path': str(evidence), 'sha256': common.sha(evidence), 'modelCalls': 0,
                    'stoppedBeforeNetwork': True, 'snapshotSha256': snapshot['sha256'],
                    'promptBinding': {key: actual.get(key) for key in ('configuredSystemSha256', 'appendSystemSha256', 'actualContextSystemSha256')},
                    'tools': [tool['name'] for tool in actual['serialized']]}
        result = common.durable_phase(folder, 'result', identity, operation)
        preparation.verify_files({result['path']: result['sha256']}, 'Serialized package tools')
        actual = json.loads(Path(result['path']).read_text())
        if first:
            expected = json.loads(Path(first['path']).read_text())
            if any(actual[key] != expected[key] for key in ('registered', 'serialized')):
                raise ValueError('Package registered/sent tools differ between frozen questions')
        else:
            first = result
        manifest.setdefault('serialization', {})[qid] = result
    manifest['toolEvidence'] = {'package': {key: first[key] for key in ('path', 'sha256', 'modelCalls', 'stoppedBeforeNetwork')}}
    if manifest['state'] == 'prepared':
        manifest['state'] = 'serialization-complete'
    common.write_json(output / 'manifest.json', manifest)


def context_estimate(config, session):
    process = subprocess.run(['node', str(HERE / 'sdk/context-estimate.mjs'), '--sdk-path', config['sdk_path'], '--session', str(session)],
                             capture_output=True, text=True, check=True, env=common.child_env())
    return json.loads(process.stdout)

def context_budget(config, manifest, session, phase, destination=None):
    estimated = context_estimate(config, session)
    descriptor = manifest['answerDescriptor']
    generation = descriptor['maxTokens']
    ceiling = descriptor['contextWindow'] - generation - config['protocol']['overhead_tokens']
    result = {'estimatedTokens': estimated['estimatedTokens'], 'generationReserve': generation, 'ceiling': ceiling,
              'estimator': 'installed SDK chars/4; not provider token usage', 'phase': phase}
    target = session.parent if destination is None else destination
    target.mkdir(parents=True, exist_ok=True)
    common.write_json(target / (phase + '-context-budget.json'), result)
    return result
