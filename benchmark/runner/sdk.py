"""SDK answer commands, frozen wrappers, serialization proof, and token estimates."""
import json
from pathlib import Path
import subprocess
from runner import artifacts as common
from runner import prepare as preparation

HERE = Path(__file__).resolve().parent.parent


def plain_rpc(command, env, directory, **kwargs):
    observed = common.rpc.run_rpc(command, env, directory, collect_memory=True, **kwargs)
    common.write_json(Path(directory) / 'process-memory.json', observed.get('memory'))
    return observed


def answer_command(output, config, pins, arm, folder, session, evidence, expected=None, stop=False):
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


def context_budget(config, manifest, session, phase, destination=None):
    process = subprocess.run(['node', str(common.ROOT / 'benchmark/sdk/context-estimate.mjs'), '--sdk-path', config['sdk_path'], '--session', str(session)],
                             capture_output=True, text=True, check=True, env=common.child_env())
    estimated = json.loads(process.stdout)
    descriptor = manifest['answerDescriptor']
    generation = descriptor['maxTokens']
    ceiling = descriptor['contextWindow'] - generation - config['protocol']['overhead_tokens']
    result = {'estimatedTokens': estimated['estimatedTokens'], 'generationReserve': generation, 'ceiling': ceiling,
              'estimator': 'installed SDK chars/4; not provider token usage', 'phase': phase}
    target = session.parent if destination is None else destination
    target.mkdir(parents=True, exist_ok=True)
    common.write_json(target / (phase + '-context-budget.json'), result)
    return result
