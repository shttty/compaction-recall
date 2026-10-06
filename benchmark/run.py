"""Current English LME16 fixed-snapshot native/lite/full answer, grade, report and resume."""
import argparse
import json
from pathlib import Path
from runner import artifacts as common
from runner import execution, prepare as preparation




def parser(dataset='LME16-English'):
    value = argparse.ArgumentParser(description=__doc__ if dataset == 'LME16-English' else 'Current SWE-chat fixed-snapshot full-production flow.')
    for name in ('config', 'data-root', 'output'):
        value.add_argument('--' + name, type=Path, required=True)
    value.add_argument('--snapshot-source', type=Path, help='Required for LME16; SWE defaults to question-bound snapshot paths')
    value.add_argument('--dataset', choices=('LME16-English', 'SWE-chat'), default=dataset)
    value.add_argument('--source-root', type=Path, default=common.ROOT)
    value.add_argument('--arm', choices=(*preparation.ARMS, 'all'), default='pi-full')
    value.add_argument('--workers', type=int, choices=range(1, 9), default=8)
    value.add_argument('--stage', choices=('prepare', 'pilot', 'all', 'flow'), default='flow')
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
    if args.dataset == 'LME16-English' and args.snapshot_source is None:
        arguments.error('LME16-English requires --snapshot-source')
    if args.snapshot_source is not None and not args.snapshot_source.is_dir():
        arguments.error('missing external input --snapshot-source: ' + str(args.snapshot_source))
    results = execution.run_arms(args)
    print(json.dumps(results), flush=True)
    if any(row['state'] not in execution.SUCCESS_STATES for row in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
