"""Evaluate Pi native/lite/full or a declared third-party package on LME16/SWE-chat."""
import argparse
import json
from pathlib import Path
from runner import artifacts as common
from runner import execution, prepare as preparation




def parser(dataset='LME16-English'):
    value = argparse.ArgumentParser(description=__doc__)
    for name in ('config', 'data-root', 'output'):
        value.add_argument('--' + name, type=Path, required=True)
    value.add_argument('--snapshot-source', type=Path, help='Required for LME16; SWE defaults to question-bound snapshot paths')
    value.add_argument('--dataset', choices=('LME16-English', 'LME16-Chinese', 'SWE-chat'), default=dataset)
    value.add_argument('--source-root', type=Path, default=common.ROOT)
    value.add_argument('--package-root', type=Path, help='Installed unpacked Pi package; required by --arm package')
    value.add_argument('--compression', choices=('native', 'package'), default='native')
    value.add_argument('--baseline-source', type=Path, help='External corresponding baseline; required for Chinese prompt/reference identity')
    value.add_argument('--question-id', action='append', help='Repeatable offline prepare/preflight subset; paid stages remain fixed datasets')
    value.add_argument('--arm', choices=(*preparation.ARMS, 'all'), default='pi-full')
    value.add_argument('--workers', type=int, choices=range(1, 9), default=8)
    value.add_argument('--stage', choices=('prepare', 'preflight', 'pilot', 'all', 'flow'), default='flow')
    return value


def main(dataset='LME16-English'):
    arguments = parser(dataset)
    args = arguments.parse_args()
    if not args.config.is_file():
        arguments.error('missing external input --config: ' + str(args.config))
    if not args.data_root.is_dir():
        arguments.error('missing external input --data-root: ' + str(args.data_root))
    if not args.source_root.is_dir():
        arguments.error('missing source root --source-root: ' + str(args.source_root))
    if args.dataset.startswith('LME16-') and args.snapshot_source is None:
        arguments.error('LME16 requires --snapshot-source')
    if args.arm == 'package' and (args.package_root is None or not args.package_root.is_dir()):
        arguments.error('--arm package requires an installed --package-root directory')
    if args.arm != 'package' and (args.package_root is not None or args.compression != 'native'):
        arguments.error('--package-root and package compression require --arm package')
    if args.dataset == 'LME16-Chinese' and args.baseline_source is None:
        arguments.error('LME16-Chinese requires --baseline-source for the historical reference/prompt binding')
    if args.question_id and args.stage not in ('prepare', 'preflight'):
        arguments.error('--question-id is only available for offline prepare/preflight')
    if args.snapshot_source is not None and not args.snapshot_source.is_dir():
        arguments.error('missing external input --snapshot-source: ' + str(args.snapshot_source))
    results = execution.run_arms(args)
    print(json.dumps(results), flush=True)
    if any(row['state'] not in execution.SUCCESS_STATES for row in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
