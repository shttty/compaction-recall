"""Arm, pilot, concurrent cases, report, and numerical-grading orchestration."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
from runner import artifacts as common
from runner import cases, prepare as preparation, resources, sdk

HERE = Path(__file__).resolve().parent.parent
SUCCESS_STATES = ('prepared', 'serialization-complete', 'pilot-valid', 'complete')


def run(args):
    output, config, pins, manifest, configs, paths = preparation.prepare(args)
    if args.stage == 'prepare':
        return manifest
    scope = resources.whole_scope()
    resource = resources.RunResources(output, manifest, args.workers, scope)
    arm = resource.arm
    def case(question):
        cases.execute(resource, config, pins, paths, configs, question)
    cases.validate_cached_results(output, config, pins, manifest, configs, paths)
    if manifest['state'] in ('complete', 'partial', 'failed', 'capacity-blocked'):
        sdk.serialization(output, config, pins, manifest, rpc_runner=resource.measured_rpc)
        return manifest
    sdk.serialization(output, config, pins, manifest, rpc_runner=resource.measured_rpc)
    resource.persist()
    print('CURRENT_SCOPE_READY ' + json.dumps({'manifest': str(output / 'manifest.json'), 'scope': scope.name, 'stage': args.stage}), flush=True)
    if args.stage == 'preflight':
        return manifest
    pilot = manifest['questions'][0]
    case(pilot)
    if resource.capacity_stop.is_set():
        manifest['state'] = 'capacity-blocked'; resource.persist(); return manifest
    if pilot['id'] in manifest['failures']:
        manifest['state'] = 'pilot-blocked'; resource.persist(); return manifest
    answer = json.loads((output / 'results' / arm / pilot['id'] / 'result.json').read_text())
    judged = {label: json.loads((output / 'judge-v2' / label / arm / pilot['id'] / 'result.json').read_text()) for label in ('luna', 'sol')}
    valid = answer['outcome'] == 'answered' and all(row['status'] == 'graded' for row in judged.values())
    manifest['pilot'] = {'id': pilot['id'], 'valid': valid, 'countsIn16': True,
                         'correct': {label: (row.get('verdict') or {}).get('correct') for label, row in judged.items()}}
    manifest['state'] = 'pilot-valid' if valid else 'pilot-blocked'; resource.persist()
    if not valid or args.stage == 'pilot': return manifest
    manifest['state'] = 'running'; resource.persist()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = [pool.submit(case, question) for question in manifest['questions'][1:]]
        for job in as_completed(jobs): job.result()
    preparation.verify_files(manifest['identity']['inputs'], 'Frozen run input')
    preparation.verify_files({str(Path(pins['sqlite']['path']) / name): digest for name, digest in pins['sqlite']['filesSha256'].items()}, 'Frozen candidate')
    preparation.verify_files(manifest['identity']['snapshotSource']['filesSha256'], 'Snapshot source bytes')
    manifest['state'] = ('capacity-blocked' if resource.capacity_stop.is_set() else 'complete' if len(manifest['completed']) == len(manifest['selected'])
                         else 'partial' if manifest['completed'] else 'failed')
    resource.persist()
    return manifest


def flow(args):
    manifest = run(args)
    output = args.output.resolve()
    reporter = common.module('current_report', HERE / 'report.py')
    reporter.write_report(output)
    if manifest['state'] != 'complete':
        return manifest
    grader = common.module('current_grade', HERE / 'judging/score.py')
    graded = grader.run(output, workers=args.workers)
    reporter.write_report(output)
    preparation.verify_files(manifest['identity']['sources'], 'Execution source')
    return graded


def run_arms(args):
    original_output, selected_arm = args.output.resolve(), args.arm
    args.shared_output = original_output
    arms = preparation.NATIVE_ARMS if selected_arm == 'all' else (selected_arm,)
    results = []
    for arm in arms:
        args.arm = arm
        args.output = original_output / arm if selected_arm == 'all' else original_output
        result = flow(args) if args.stage == 'flow' else run(args)
        if args.stage in ('pilot', 'all'):
            reporter = common.module('current_phase_report', HERE / 'report.py')
            reporter.write_report(args.output)
        results.append({'arm': arm, 'state': result['state'], 'completed': len(result.get('completed', [])), 'failures': len(result.get('failures', {}))})
        if result['state'] not in SUCCESS_STATES:
            break
    return results
