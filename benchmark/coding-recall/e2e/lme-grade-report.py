#!/usr/bin/env python3
"""Offline 1–10 supplement for immutable Chinese answers; never calls providers."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import statistics

HERE = Path(__file__).resolve().parent


def _module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


common = _module('grade_report_common', 'run.py')
old_report = _module('grade_report_old', 'lme-zh-report.py')
strict = old_report.contract
ARM = 'pi-rawfts'
JUDGES = ('luna', 'sol')
GROUPS = ('dev8', 'hard8', 'total')
TOKENS = ('input', 'output', 'cacheRead', 'cacheWrite')
PENDING = ('unknown', 'pending', 'inflight', 'running', 'prepared')


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=strict._unique_object,
                      parse_constant=strict._reject_constant)


def bounded(root, value):
    path = Path(value)
    path = (path if path.is_absolute() else root / path).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Artifact reference escapes permitted root')
    return path


def sha(path):
    return common.sha(path)


def check_hash(path, expected):
    if not isinstance(expected, str) or sha(path) != expected:
        raise ValueError('Artifact hash mismatch: ' + str(path))


def check_session(root, record, required=False):
    session = record.get('session')
    if not session:
        if required or record.get('sessionSha256'):
            raise ValueError('Missing saved session')
        return
    path = bounded(root, session)
    if path.name not in ('session.jsonl', 'judge-session.jsonl'):
        raise ValueError('Disallowed session artifact')
    check_hash(path, record.get('sessionSha256'))


def check_identity(record, qid, label=None, arm=ARM):
    expected = {'arm': arm, 'question_id': qid}
    if label is not None:
        expected['judgeName'] = label
    if any(record.get(key) != value for key, value in expected.items()):
        raise ValueError('Saved result identity mismatch: ' + qid)


def hash_inventory(root, inventory):
    if not isinstance(inventory, dict) or not inventory:
        raise ValueError('Missing immutable artifact inventory')
    checked = []
    for value, digest in inventory.items():
        path = bounded(root, value)
        # Historical generated configs contain path-only profile references;
        # hash their bytes, never parse them or follow those references.
        if re.search(r'(?:credential|profile|auth|secret)', path.name, re.I):
            raise ValueError('Forbidden inventory artifact')
        check_hash(path, digest)
        checked.append(str(path))
    return checked


def input_inventory(original_manifest, inventory, selected):
    names = ('question.json', 'answer.json') if original_manifest['identity']['dataset'] == 'LME16-English' else ('question-zh.json', 'question.json', 'answer.json')
    if not isinstance(inventory, dict) or len(inventory) != len(names) * len(selected):
        raise ValueError('Dataset input inventory coverage differs')
    frozen = original_manifest['identity']['inputs']
    checked, cases = [], {}
    for filename, digest in inventory.items():
        path = Path(filename).resolve()
        if (str(path) not in frozen or frozen[str(path)] != digest or path.name not in
                names or
                path.parent.name not in selected or path.parent.parent.name not in ('dev8', 'hard8') or
                path.parent.parent.parent.name != 'data' or path.is_symlink()):
            raise ValueError('Unauthorized dataset input artifact')
        check_hash(path, digest)
        key = (path.parent.name, path.name)
        if key in cases:
            raise ValueError('Duplicate dataset input artifact')
        cases[key] = {'path': str(path), 'sha256': digest, 'value': read_json(path)}
        checked.append(str(path))
    if any((qid, name) not in cases for qid in selected for name in names):
        raise ValueError('Dataset input matrix differs')
    return checked, cases


def read_attempts(root, directory, record, filename='result.json'):
    summaries = record.get('attempts')
    observed = {}
    folder = directory / 'attempts'
    if folder.is_dir():
        for child in sorted(folder.iterdir()):
            if child.is_dir() and re.fullmatch(r'\d+', child.name):
                path = bounded(root, child / filename)
                if path.is_file():
                    observed[int(child.name)] = (path, read_json(path))
    if isinstance(summaries, list):
        indices = [summary.get('attempt', i) for i, summary in enumerate(summaries, 1)]
        if len(indices) != len(set(indices)) or indices != sorted(indices):
            raise ValueError('Duplicate or unordered attempts')
        for index, summary in zip(indices, summaries):
            if summary.get('path') and bounded(root, summary['path']) != observed.get(index, (None,))[0]:
                raise ValueError('Attempt path mismatch')
            if index in observed and summary.get('status') not in (None, observed[index][1].get('status')):
                raise ValueError('Attempt status mismatch')
        if set(observed) - set(indices):
            raise ValueError('Unlisted persisted attempt')
        complete = set(indices) == set(observed)
    else:
        complete = False
    rows = []
    for index, (path, value) in observed.items():
        check_session(root, value)
        rows.append({'attempt': index, 'path': str(path), 'sha256': sha(path), 'record': value})
    return rows, complete


def verdict_record(root, path, qid, label, answer, score=False, item=None, fingerprint=None, arm=ARM):
    exists = path.is_file()
    marker = path.with_name('result-state.json')
    if not exists:
        record = {'status': 'inflight' if marker.is_file() else 'missing', 'verdict': None,
                  'arm': arm, 'question_id': qid, 'judgeName': label}
        if score:
            record.update(identity=common.e.object_sha({'run': fingerprint, 'judgeName': label, 'arm': arm,
                'question_id': qid, 'inputSha256': item['inputSha256']}),
                inputSha256=item['inputSha256'], originalResultSha256=item['originalResultSha256'])
    else:
        record = read_json(path)
    check_identity(record, qid, label, arm=arm)
    check_session(root, record, required=score and record.get('status') == 'graded')
    if score:
        identity = common.e.object_sha({'run': fingerprint, 'judgeName': label, 'arm': arm,
                                      'question_id': qid, 'inputSha256': item['inputSha256']})
        if record.get('identity') != identity:
            raise ValueError('Grade fingerprint identity mismatch')
        for key in ('inputSha256', 'originalResultSha256'):
            if record.get(key) != item[key]:
                raise ValueError('Grade input binding mismatch')
    status = record.get('status', 'unknown')
    verdict = None
    if status == 'graded':
        parser = common.scorer.parse_score if score else lambda text: strict.parse_verdict(text, answer)
        verdict = parser(record.get('rawVerdict'))
        if parser(json.dumps(record.get('verdict'), ensure_ascii=False)) != verdict:
            raise ValueError('Saved and raw verdict differ')
    elif record.get('verdict') is not None:
        raise ValueError('Non-graded result has a verdict')
    attempts, complete = read_attempts(root, path.parent, record)
    for attempt in attempts:
        value = attempt['record']
        check_identity(value, qid, label, arm=arm)
        check_session(root, value, required=score and value.get('status') == 'graded')
        if score:
            attempt_identity = common.e.object_sha({'run': fingerprint + '/' + str(attempt['attempt']),
                'judgeName': label, 'arm': arm, 'question_id': qid, 'inputSha256': item['inputSha256']})
            if value.get('identity') != attempt_identity:
                raise ValueError('Attempt fingerprint identity differs')
            if any(value.get(key) != item[key] for key in ('inputSha256', 'originalResultSha256')):
                raise ValueError('Attempt input binding mismatch')
        marker = Path(attempt['path']).with_name('result-state.json')
        if marker.is_file():
            saved_state = read_json(marker)
            if saved_state.get('identity') != value.get('identity'):
                raise ValueError('Attempt marker identity differs')
            if saved_state.get('state') == 'complete':
                check_hash(Path(attempt['path']), saved_state.get('resultSha256'))
        if value.get('status') == 'graded':
            parsed = (common.scorer.parse_score(value.get('rawVerdict')) if score else
                      strict.parse_verdict(value.get('rawVerdict'), answer))
            if parsed != value.get('verdict'):
                raise ValueError('Attempt saved and raw verdict differ')
    if score and attempts and complete:
        last = attempts[-1]['record']
        for key in ('status', 'verdict', 'rawVerdict', 'sessionSha256'):
            if record.get(key) != last.get(key):
                raise ValueError('Final result differs from last attempt')
    marker = path.with_name('result-state.json')
    if marker.is_file():
        state = read_json(marker)
        if score and state.get('identity') != record['identity']:
            raise ValueError('Phase marker identity differs')
        if exists and state.get('state') == 'complete':
            check_hash(path, state.get('resultSha256'))
    return {'status': status, 'verdict': verdict, 'path': str(path), 'sha256': sha(path) if exists else None,
            'record': record if exists else None, 'attempts': attempts, 'attemptsComplete': complete}


def quality(rows, score=False):
    valid = [row['verdict'] for row in rows if row['status'] == 'graded']
    counts = {'selected': len(rows), 'scored': len(valid),
              'failed': sum(row['status'] not in ('graded', 'missing', *PENDING) for row in rows),
              'missing': sum(row['status'] == 'missing' for row in rows),
              'pending': sum(row['status'] in PENDING for row in rows),
              'coverage': len(valid) / len(rows) if rows else None,
              'coverageDenominator': len(rows)}
    counts['failureKinds'] = {status: sum(row['status'] == status for row in rows) for status in
                             ('provider-error', 'judge-error', 'answer-failure', 'answer-failure-not-scored')}
    if score:
        total = sum(v['score'] for v in valid) if valid else None
        counts.update(totalScore=total, effectiveMax=10 * len(valid),
                      mean=total / len(valid) if valid else None, meanDenominator=len(valid))
    else:
        correct = sum(v['correct'] for v in valid)
        counts.update(correct=correct, wrong=len(valid) - correct,
                      accuracy=correct / len(valid) if valid else None, accuracyDenominator=len(valid))
    if counts['scored'] + counts['failed'] + counts['missing'] + counts['pending'] != len(rows):
        raise ValueError('Quality denominator mismatch')
    return counts


def measured(values):
    values = list(values)
    observed = [v for v in values if number(v)]
    return {'observed': len(observed), 'missing': len(values) - len(observed),
            'sum': sum(observed) if observed else None,
            'mean': statistics.mean(observed) if observed else None,
            'median': statistics.median(observed) if observed else None,
            'availability': 'complete' if observed and len(observed) == len(values) else
                            'lower-bound' if observed else 'unknown'}


def usage_summary(attempts, complete):
    summary = {}
    for field in TOKENS:
        value = measured((sample or {}).get(field) for a in attempts
                         for sample in a.get('tokenSamples', [a.get('tokens')]))
        if not complete and value['availability'] == 'complete':
            value['availability'] = 'lower-bound'
        summary[field] = value
    return summary


def phase_summary(questions):
    attempts = [a for q in questions for a in q['attempts']]
    complete = all(q['complete'] for q in questions)
    durations = [sum(a['seconds'] for a in q['attempts']) if q['complete'] and q['attempts'] and
                 all(number(a.get('seconds')) for a in q['attempts']) else None for q in questions]
    calls = measured(a.get('modelCalls') for a in attempts)
    if not complete and calls['availability'] == 'complete':
        calls['availability'] = 'lower-bound'
    task_time = measured(a.get('seconds') for a in attempts)
    if not complete and task_time['availability'] == 'complete':
        task_time['availability'] = 'lower-bound'
    retries = [q.get('retriesObserved', max(0, len(q['attempts']) - 1)) for q in questions]
    failures = measured(1 if a.get('status', a.get('outcome')) in ('provider-error', 'judge-error', 'model-error') or a.get('success') is False else
                        0 if a.get('status', a.get('outcome')) in ('graded', 'answered') or a.get('success') is True else None for a in attempts)
    if not complete and failures['availability'] == 'complete':
        failures['availability'] = 'lower-bound'
    return {'selected': len(questions), 'attemptsObserved': len(attempts),
            'attemptsComplete': complete, 'attempts': len(attempts) if complete else None,
            'retries': sum(retries) if complete else None,
            'retriesObserved': sum(retries), 'attemptFailures': failures,
            'finalFailures': sum(q['status'] not in ('graded', 'answered', 'complete', 'missing', *PENDING)
                                 for q in questions),
            'missing': sum(q['status'] == 'missing' for q in questions),
            'pending': sum(q['status'] in PENDING for q in questions),
            'calls': calls, 'perQuestionSeconds': measured(durations),
            'taskSeconds': task_time,
            'tokens': usage_summary(attempts, complete), 'cost': None,
            'costAvailability': 'unknown; SDK configured zero cost is not billing',
            'tokenConvention': 'SDK input is uncached input; cacheRead/cacheWrite separate; no context-size estimates'}


def judge_resources(row, new=False):
    attempts = [a['record'] for a in row['attempts']]
    return {'status': row['status'], 'complete': row['attemptsComplete'],
            'attempts': [{**a, 'modelCalls': 1 if new else a.get('modelCalls',
                          1 if a.get('tokens') is not None or a.get('judgeEvidence') else None)} for a in attempts]}


def old_resources(row, original_root):
    answer = row['answer']
    compression = row['compression']
    if compression.get('reused'):
        original_root = Path(compression['sourceRun']).resolve()
        compression = compression['sourceCost']
    answer_attempts = [{'seconds': a.get('wallMs') / 1000 if number(a.get('wallMs')) else None,
                        'tokens': a.get('tokens'), 'modelCalls': a.get('modelCalls'), 'outcome': a.get('outcome')}
                       for a in answer.get('attempts', [])]
    stages = compression.get('attemptsObserved') or []
    comp_attempts = []
    for a in stages:
        value = a.get('result') or {}
        response = value.get('response') or {}
        directory = bounded(original_root, Path('compression/pi') / row['id'] / 'stages' / a['stage'] / 'attempts' / a['attempt'])
        requests_path, replies_path = directory / 'wire-requests.jsonl', directory / 'wire-results.jsonl'
        requests = ([json.loads(line) for line in requests_path.read_text().split('\n') if line.strip()]
                    if requests_path.is_file() else None)
        replies = ([json.loads(line) for line in replies_path.read_text().split('\n') if line.strip()]
                   if replies_path.is_file() else None)
        if any(r.get('phase') != 'compression' for r in (requests or []) + (replies or [])):
            raise ValueError('Native wire metadata phase differs')
        samples = ([r.get('usage') for r in replies] if replies is not None else
                   [(response.get('data') or {}).get('usage')])
        if requests is not None and replies is not None:
            samples += [None] * max(0, len(requests) - len(replies))
        comp_attempts.append({'seconds': value.get('seconds'), 'success': value.get('success'),
                              'tokens': (response.get('data') or {}).get('usage'), 'tokenSamples': samples or [None],
                              'modelCalls': len(requests) if requests is not None else
                                            0 if value.get('failureKind') == 'local-context-preflight' else None})
    expected = compression.get('stagesObserved')
    complete = bool(stages) and expected is not None and len({a.get('stage') for a in stages}) == expected
    return ({'status': answer.get('state', 'missing'), 'complete': answer.get('attemptsComplete', False), 'attempts': answer_attempts},
            {'status': compression.get('state', 'missing'), 'complete': complete, 'attempts': comp_attempts,
             'retriesObserved': len(stages) - len({a.get('stage') for a in stages})})


def safe_identity(identity):
    """Report operational identity, never dump embedded historical SDK configs."""
    config = identity.get('config') or {}
    models = {phase: {key: (config.get(phase) or {}).get(key) for key in ('provider', 'model', 'effort')}
              for phase in ('compression', 'answer')}
    models['judges'] = {label: {key: ((identity.get('judgeConfigs') or {}).get(label, {}).get('judge') or {}).get(key)
                              for key in ('provider', 'model', 'effort')} for label in JUDGES}
    candidate = (identity.get('pins') or {}).get('sqlite') or {}
    return {key: identity.get(key) for key in ('task', 'dataset', 'ranking', 'candidateEnvironment',
            'arm',
            'questionPolicy', 'compressionPolicy', 'resourcePolicy', 'retryPolicy', 'judgePromptSha256')} | {
            'snapshotSource': {key: (identity.get('snapshotSource') or {}).get(key) for key in ('run', 'fingerprint', 'manifestPath', 'manifestSha256')},
            'models': models, 'candidate': {key: candidate.get(key) for key in ('commit', 'archiveSha256', 'path', 'sdkPath')}}


def resource_table(original, manifest, resource, per_question):
    phases = {}
    old_answers, old_compressions = zip(*(old_resources(q['oldMetrics'], Path(manifest['identity']['originalRun'])) for q in per_question))
    concepts = manifest['identity'].get('arm') in ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep')
    compression_stage = 'SOURCE historical compression' if concepts else 'OLD compression'
    answer_stage = 'CURRENT answers' if concepts else 'OLD answers'
    phases[compression_stage] = phase_summary(old_compressions)
    phases[answer_stage] = phase_summary(old_answers)
    for label in JUDGES:
        phases[('CURRENT strict ' if concepts else 'OLD strict ') + label] = phase_summary([judge_resources(q['strict'][label]) for q in per_question])
        phases['NEW graded ' + label] = phase_summary([judge_resources(q['scores'][label], True) for q in per_question])
    rows = []
    def add(stage, metric, value, unit, evidence):
        rows.append({'stage': stage, 'metric': metric, 'value': value, 'unit': unit, 'evidence': evidence})
    old_resource = original.get('resource') or {}
    for stage, value, policy in (('CURRENT native run' if concepts else 'OLD whole run', old_resource, (original.get('identity') or {}).get('resourcePolicy') or {}),
                                 ('NEW supplement', resource or {}, manifest['identity'].get('resourcePolicy') or {})):
        add(stage, 'wall clock', value.get('wallSeconds'), 'seconds; wall, not task-time sum',
            {'startedAt': value.get('startedAt'), 'finishedAt': value.get('finishedAt'),
             'scope': 'scheduler; excludes input freeze and SDK describe/preparation' if stage == 'NEW supplement' else 'historical run scope',
             'availability': 'observed' if number(value.get('wallSeconds')) else 'unknown; no trusted elapsed measurement'})
        add(stage, 'worker configuration', value.get('questionWorkers', value.get('workers',
            policy.get('questionWorkers', policy.get('maxConcurrentSessions')))),
            'configured questions; historical configuration is not supplement configuration', policy)
        aliases = {'peakActiveProviderRequests': 'peakActiveRpcSessions', 'providerConcurrencyCeiling': 'maxConcurrentSessions',
                   'memoryMaxBytes': 'wholeRunMemoryMaxBytes', 'swapMaxBytes': 'wholeRunMemorySwapMaxBytes'}
        for key in ('peakActiveQuestions', 'peakActiveProviderRequests', 'providerConcurrencyCeiling', 'memoryMaxBytes', 'swapMaxBytes'):
            alias = aliases.get(key, key)
            observed = value.get(key, value.get(alias, policy.get(key, policy.get(alias))))
            add(stage, key, observed,
                'bytes' if 'Bytes' in key else ('active RPC sessions, including startup/shutdown; not exact HTTP concurrency' if key == 'peakActiveProviderRequests' else 'count; observed peak distinct from configuration'),
                {'source': 'saved resource.json / identity.resourcePolicy', 'nativeAlias': alias if alias != key else None})
        add(stage, 'process-tree cgroup memory peak', value.get('memoryPeakBytes'), 'bytes; /1048576 = MiB; never summed RSS',
            {'cgroupPath': value.get('cgroupPath'), 'scopeName': value.get('scopeName'),
             'coverage': ('shared cumulative outer scope including native answer/strict and graded sessions; not isolated graded-stage increment'
                          if concepts and stage == 'NEW supplement' else 'saved native scope observation' if concepts else 'saved phase scope observation')})
    for stage, data in phases.items():
        for metric, value, unit in (('per-question time', data['perQuestionSeconds'], 'seconds; median/mean and coverage'),
                                    ('task-time sum', data['taskSeconds'], 'seconds; includes observed attempts, not wall'),
                                    ('calls', data['calls'], 'model calls; observed sum and coverage'),
                                    ('attempts/retries/final failures', {k: data[k] for k in ('attempts', 'attemptsObserved', 'attemptsComplete', 'retries', 'retriesObserved', 'attemptFailures', 'finalFailures', 'missing', 'pending')}, 'counts'),
                                    ('cost', None, 'unknown; no billing price source')):
            add(stage, metric, value, unit, 'persisted attempts; absent measurements remain unknown/lower-bound')
        for field in TOKENS:
            add(stage, field + ' tokens', data['tokens'][field], 'tokens; uncached input/output/cacheRead/cacheWrite separate', data['tokenConvention'])
    add('NEW supplement', 'compression calls', 0, 'calls', 'immutable snapshot reused; no compression phase')
    add('NEW supplement', 'answer calls', 0, 'calls', 'immutable saved answers reused; no answer phase')
    if concepts:
        add('CURRENT native run', 'compression calls', 0, 'calls', 'reused snapshots; SOURCE historical compression costs are excluded from current run')
        add('SOURCE historical compression', 'build and source evidence',
            [{'id': q['id'], 'sourceRun': q['oldMetrics']['compression'].get('sourceRun'),
              'sourceFingerprint': q['oldMetrics']['compression'].get('sourceFingerprint'),
              'buildState': (q['oldMetrics']['compression'].get('sourceBuild') or {}).get('state'),
              'costEvidenceFiles': len(q['oldMetrics']['compression'].get('sourceCostFilesSha256', {}))}
             for q in per_question], 'historical saved build/cost only; not new calls',
            'identity.snapshotSource in ../manifest.json; full per-question build/cost hash inventory in aggregate.json')
    for metric in ('main-thread heap', 'worker heap', 'worker external', 'background index prepare time',
                   'first-request index waiting', 'longest main-thread stall', 'cold full-tool query roundtrip',
                   'hot full-tool query roundtrip'):
        add('index / worker / retrieval', metric, None, 'MiB for memory; ms for timing; no summing heap/external/RSS',
            'unknown; no validated same-run observation for this metric; not estimated')
    add(answer_stage, 'process RSS / per-process memory observations', [q['oldMetrics']['answer'].get('processMemory') for q in per_question],
        'raw RSS observations with sampling/GC method and coverage; not cgroup memory; heap/external not added', 'validated original aggregate')
    add('CURRENT retrieval' if concepts else 'OLD retrieval', 'calls and diagnostics', [q['oldMetrics']['answer'].get('retrieval') for q in per_question],
        'recall/grep/expand, errors, actual zero warnings, empty pages and subsequent actions', 'validated original aggregate; no causal inference from wrong answers')
    if concepts:
        add('CURRENT automatic recall', 'provider context locator evidence',
            [q['oldMetrics']['answer'].get('automaticRecall') for q in per_question],
            'saved context requests; separate from active history tools', 'before_provider_request context artifacts; no inferred query rewrites')
    return {'phases': phases, 'rows': rows, 'oldResource': old_resource, 'newResource': resource,
            'newCompressionCalls': 0, 'newAnswerCalls': 0}


def load_report(root):
    root = Path(root).resolve()
    if root.name != 'grade-1to10':
        raise ValueError('Supplement must be named grade-1to10')
    manifest = read_json(root / 'manifest.json')
    identity = manifest['identity']
    if common.e.object_sha(identity) != manifest['fingerprint']:
        raise ValueError('Manifest fingerprint differs from identity')
    original_root = Path(identity['originalRun']).resolve()
    if original_root != root.parent:
        raise ValueError('Supplement is not under its immutable original run')
    originals_checked = hash_inventory(original_root, identity['originalFilesSha256'])
    if identity.get('promptSha256') != hashlib.sha256(common.scorer.JUDGE_PROMPT.encode()).hexdigest():
        raise ValueError('Grading rule prompt hash differs')
    original_manifest = read_json(original_root / 'manifest.json')
    if original_manifest['fingerprint'] != identity['originalFingerprint']:
        raise ValueError('Original fingerprint mismatch')
    original = read_json(original_root / 'aggregate.json')
    arm = old_report.manifest_arm(original_manifest)
    if identity.get('arm', ARM) != arm:
        raise ValueError('Supplement arm identity differs')
    if arm in ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep'):
        policy = identity.get('resourcePolicy', {})
        if policy.get('questionWorkers') != 8 or policy.get('providerConcurrencyCeiling') != 8:
            raise ValueError('Structured recall supplement requires eight-worker resource policy')
        if arm in ('pi-grep-fallback', 'pi-restored-grep') and (policy.get('memoryMaxBytes') != 14 * 1024 ** 3 or policy.get('swapMaxBytes') != 0):
            raise ValueError('Fallback supplement requires one 14GiB zero-swap scope')
        old_report.reused_source(original_manifest)
        snapshot_source = original_manifest['identity']['snapshotSource']
        source_files = identity.get('snapshotSourceFilesSha256', {})
        if any(source_files.get(path) != digest for path, digest in snapshot_source['filesSha256'].items()):
            raise ValueError('Missing immutable snapshot-source inventory')
        for path, digest in source_files.items():
            if path not in snapshot_source['filesSha256']:
                bounded(Path(snapshot_source['run']).resolve() / 'compression', path)
            old_report.check_source_hash(path, digest)
    if original.get('fingerprint') != identity['originalFingerprint']:
        raise ValueError('Original aggregate fingerprint mismatch')
    selected = manifest['selected']
    if (len(selected) != len(set(selected)) or selected != original_manifest['selected'] or
            selected != original['selected'] or any(not re.fullmatch(r'[A-Za-z0-9_-]+', qid) for qid in selected)):
        raise ValueError('Selected immutable question matrix differs')
    inputs_checked, cases = input_inventory(original_manifest, identity['inputFilesSha256'], selected)
    results_directory = bounded(root, 'results')
    if results_directory.is_dir():
        for label_directory in results_directory.iterdir():
            if not label_directory.is_dir() or label_directory.name not in JUDGES:
                raise ValueError('Unexpected grading result label')
            for question_directory in label_directory.iterdir():
                if not question_directory.is_dir() or question_directory.name not in selected:
                    raise ValueError('Unexpected grading result question')
                bounded(root, question_directory)
    if common.e.object_sha(original_manifest['identity']) != identity['originalFingerprint']:
        raise ValueError('Original manifest identity differs')
    required = [original_root / name for name in ('manifest.json', 'aggregate.json')]
    required += [original_root / 'results' / arm / qid / 'result.json' for qid in selected]
    required += [original_root / 'judge-v2' / label / arm / qid / 'result.json'
                 for label in JUDGES for qid in selected]
    if any(str(path) not in originals_checked for path in required if path.is_file()):
        raise ValueError('Immutable artifact inventory lacks loaded originals')
    inputs = read_json(root / 'inputs.json')
    if [item['question_id'] for item in inputs] != selected:
        raise ValueError('Input question matrix differs')
    old_rows = {q['id']: q for q in original['perQuestion']}
    if len(old_rows) != len(original['perQuestion']) or set(old_rows) != set(selected):
        raise ValueError('Original aggregate question coverage differs')
    questions = {q['id']: q for q in original_manifest['questions']}
    per_question = []
    for item in inputs:
        qid = item['question_id']
        if item['arm'] != arm or item['subset'] not in ('dev8', 'hard8') or questions[qid]['subset'] != item['subset']:
            raise ValueError('Question arm/subset differs')
        if item['inputSha256'] != common.e.object_sha({'prompt': item['prompt']}):
            raise ValueError('Frozen prompt hash differs')
        fields = {key: item[key] for key in ('question_en', 'question_zh', 'reference_answer', 'model_answer')}
        if item['prompt'] != common.scorer.JUDGE_PROMPT + '\n\n' + json.dumps(fields, ensure_ascii=False, allow_nan=False):
            raise ValueError('Frozen grading prompt content differs')
        if item.get('modelAnswerSha256') is not None and item['modelAnswerSha256'] != hashlib.sha256(item['model_answer'].encode()).hexdigest():
            raise ValueError('Original model-answer text hash differs')
        source = bounded(original_root, item['originalResultPath'])
        if source != original_root / 'results' / arm / qid / 'result.json':
            raise ValueError('Original answer path differs')
        check_hash(source, item['originalResultSha256'])
        answer = read_json(source)
        check_identity(answer, qid, arm=arm)
        check_session(original_root, answer)
        failed = arm in ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep') and answer.get('outcome') not in ('answered', 'missing', 'unknown', 'inflight', 'pending', 'running', None)
        if (answer.get('answer') != item['model_answer'] or
                (not failed and answer.get('outcome') != 'answered') or
                item.get('answerFailure') != (answer['outcome'] if failed else None)):
            raise ValueError('Original answer bytes/content binding differs')
        question = questions[qid]
        english_only = original_manifest['identity']['dataset'] == 'LME16-English'
        if item['question_en' if english_only else 'question_zh'] != question['question'] or item['reference_answer'] != question['answer']:
            raise ValueError('Question/reference binding differs')
        bilingual = cases[(qid, 'question.json' if english_only else 'question-zh.json')]['value']
        english = cases[(qid, 'question.json')]['value']
        reference = cases[(qid, 'answer.json')]['value']
        if isinstance(reference, dict):
            reference = reference.get('answer')
        if ((not english_only and (bilingual['question'] != item['question_zh'] or bilingual['question_en'] != item['question_en'])) or
                english['question'] != item['question_en'] or reference != item['reference_answer']):
            raise ValueError('Frozen bilingual dataset content differs')
        row = {'id': qid, 'subset': item['subset'], 'input': item,
               'datasetEvidence': {name: {key: cases[(qid, name)][key] for key in ('path', 'sha256')}
                                   for name in (('question.json', 'answer.json') if english_only else ('question-zh.json', 'question.json', 'answer.json'))},
               'originalAnswer': {'path': str(source), 'sha256': sha(source), 'record': answer},
               'oldMetrics': old_rows[qid], 'strict': {}, 'scores': {}}
        if old_rows[qid]['answer'].get('answer') != item['model_answer']:
            raise ValueError('Original aggregate answer differs')
        if arm in ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep'):
            compression = old_rows[qid]['compression']
            if compression.get('reused') is not True or compression.get('sourceRun') != snapshot_source['run']:
                raise ValueError('Aggregate compression source differs')
            if any(identity['snapshotSourceFilesSha256'].get(path) != digest
                   for path, digest in compression.get('sourceCostFilesSha256', {}).items()):
                raise ValueError('Historical compression cost inventory differs')
        for label in JUDGES:
            row['strict'][label] = verdict_record(original_root, original_root / 'judge-v2' / label / arm / qid / 'result.json',
                                                 qid, label, item['model_answer'], arm=arm)
            old_judge = row['strict'][label].get('record')
            if old_judge is not None:
                expected = common.e.object_sha({'run': identity['originalFingerprint'], 'label': label,
                    'arm': arm, 'id': qid, 'answer': common.e.object_sha(answer)})
                if old_judge.get('identity') != expected:
                    raise ValueError('Original strict fingerprint identity differs')
                if not failed:
                    prompt = strict.build_prompt(question['question'], question['answer'], answer['answer'], question.get('question_date'))
                    input_hash = common.e.object_sha({'prompt': prompt})
                    records = [old_judge] + [a['record'] for a in row['strict'][label]['attempts']]
                    if any(r.get('inputSha256') != input_hash or r.get('originalResultSha256') != item['originalResultSha256'] for r in records):
                        raise ValueError('Original strict answer/prompt binding differs')
                elif old_judge.get('status') not in ('answer-failure', 'answer-failure-not-scored') or row['strict'][label]['verdict'] is not None:
                    raise ValueError('Failed answer has a strict grade')
            if row['strict'][label]['verdict'] != old_rows[qid]['judges'][label].get('verdict'):
                raise ValueError('Original aggregate strict verdict differs')
            row['scores'][label] = verdict_record(root, root / 'results' / label / qid / 'result.json', qid, label,
                                                 item['model_answer'], True, item, manifest['fingerprint'], arm=arm)
            if failed and row['scores'][label]['status'] not in ('answer-failure-not-scored', 'missing', *PENDING):
                raise ValueError('Failed answer has a paid grade')
            graded_records = [row['scores'][label].get('record') or {}]
            graded_records += [a['record'] for a in row['scores'][label]['attempts']]
            for record in graded_records:
                if record.get('supplementFingerprint') not in (None, manifest['fingerprint']):
                    raise ValueError('Saved supplement fingerprint differs')
                if record.get('status') != 'graded':
                    continue
                evidence = record.get('judgeEvidence') or {}
                if any(evidence.get(key) != identity['judges'][label][key] for key in ('provider', 'model', 'effort')):
                    raise ValueError('Actual grading model/effort differs')
                effort = record.get('effortEvidence') or {}
                path = bounded(root, effort.get('path', 'missing-effort-evidence.json'))
                if path.name != 'effort-evidence.json':
                    raise ValueError('Disallowed effort evidence artifact')
                check_hash(path, effort.get('sha256'))
                saved_effort = read_json(path)
                if saved_effort != {'effort': identity['judges'][label]['effort'], 'source': 'onPayload'}:
                    raise ValueError('Saved grading effort differs')
        per_question.append(row)
    ledger_path = bounded(root, 'ledger.json')
    if ledger_path.is_file():
        ledger = read_json(ledger_path)
        if ledger.get('fingerprint') != manifest['fingerprint']:
            raise ValueError('Grade ledger fingerprint differs')
        observed = set()
        saved = {(q['id'], label): q['scores'][label].get('record') for q in per_question for label in JUDGES}
        for record in ledger['records']:
            key = (record.get('question_id'), record.get('judgeName'))
            if key not in saved or key in observed or record != saved[key]:
                raise ValueError('Grade ledger matrix differs from persisted results')
            observed.add(key)
        if manifest.get('state') == 'complete' and observed != {key for key, record in saved.items() if record is not None}:
            raise ValueError('Completed ledger lacks persisted result coverage')
    tables = {kind: {label: {group: quality([q[kind][label] for q in per_question if group == 'total' or q['subset'] == group], kind == 'scores')
                           for group in GROUPS} for label in JUDGES} for kind in ('strict', 'scores')}
    resource = read_json(root / 'resource.json') if (root / 'resource.json').is_file() else None
    if arm in ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep') and resource is not None:
        if any(resource.get(key) != 8 for key in ('questionWorkers', 'providerConcurrencyCeiling')) or any(
                resource.get(key, 0) > 8 for key in ('peakActiveQuestions', 'peakActiveProviderRequests', 'activeQuestions', 'activeProviderRequests')):
            raise ValueError('Structured recall grading resource ceiling differs')
        if arm in ('pi-grep-fallback', 'pi-restored-grep') and (resource.get('memoryMaxBytes') != 14 * 1024 ** 3 or resource.get('swapMaxBytes') != 0):
            raise ValueError('Fallback grading memory ceiling differs')
    verification = read_json(root / 'verification.json') if (root / 'verification.json').is_file() else None
    full_matrix = len(selected) == 16 and all(sum(q['subset'] == group for q in per_question) == 8 for group in GROUPS[:2])
    all_scored = all(tables[kind][label]['total']['scored'] == len(selected) for kind in tables for label in JUDGES)
    terminal_matrix = all(q[kind][label]['status'] not in ('missing', *PENDING)
                          for q in per_question for kind in ('strict', 'scores') for label in JUDGES)
    verified = verification is not None and verification.get('state') == 'verified' and verification.get('originalChangedFiles') == [] and verification.get('inputsChangedFiles') == []
    if verification is not None and (verification.get('newCompressionCalls') != 0 or verification.get('newAnswerCalls') != 0 or verification.get('candidateLoaded') is not False):
        raise ValueError('Supplement verification contradicts immutable reuse')
    complete = full_matrix and (terminal_matrix if arm in ('pi-grep-fallback', 'pi-restored-grep') else all_scored) and verified and manifest.get('state') == 'complete'
    return {'schemaVersion': 1, 'task': identity['task'], 'arm': arm, 'run': str(root), 'originalRun': str(original_root),
            'fingerprint': manifest['fingerprint'], 'originalFingerprint': identity['originalFingerprint'],
            'state': 'complete' if complete else 'incomplete', 'manifestState': manifest.get('state'),
            'selected': selected, 'selectedCount': len(selected), 'expectedCount': 16,
            'identity': identity, 'originalIdentity': safe_identity(original_manifest['identity']),
            'originalSnapshots': {key: {field: value.get(field) for field in ('path', 'sha256', 'language')}
                                  for key, value in original_manifest.get('snapshots', {}).items()},
            'strict': tables['strict'], 'scores': tables['scores'], 'perQuestion': per_question,
            'resources': resource_table(original, manifest, resource, per_question),
            'verification': verification, 'originalFilesChecked': originals_checked, 'inputFilesChecked': inputs_checked,
            'notes': (['Active recall rejects TOKENIZATION_LOSS before search and zero tokens as EMPTY_ANALYSIS; no automatic literal/mixed rarity fallback. Independent regex history_grep and automatic locators remain enabled.'
                       if identity.get('task') == 'RSM-ZH16-TOKEN-LOSS-REJECT-E2E-20261006' else 'Restored independent regex history_grep retains recall automatic literal/rarity fallback; internal scans are not model tool calls, and active calls and automatic locators are separate. Normal FTS zero hits are not broadened; score differences do not establish success or causality.'
                       if arm == 'pi-restored-grep' else 'Literal fallback routes zero-token or partly unindexable surfaces internally; active history calls and automatic locators are separate.'
                       if arm == 'pi-grep-fallback' else 'Concepts changes both the structured recall interface and word-internal matching semantics versus rawfts; no cross-version BM25/score calibration or comparison.',
                       'Source compression is historical reuse; this round generated new answers and strict judgments, with zero new compression calls.'] if arm in ('pi-concepts', 'pi-grep-fallback', 'pi-restored-grep') else []) + ['Strict correctness comes only from original strict v2 verdicts, never score >=8.',
                      'Quality denominators exclude failure/missing/pending; these are never zero scores or wrong answers.',
                      'Coverage denominator = selected; accuracy/mean denominator = valid verdicts; effective maximum = 10 × valid scores.',
                      'All results are read offline after judging; no report evidence is supplied to judge prompts.',
                      'Unknown metrics are null; observed failed-attempt usage contributes lower bounds, not invented zero usage.',
                      'Task-time sums are not wall clocks; configured workers are not measured active peaks; cost is unknown.',
                      'No candidate load, compression, answer generation or provider call is performed by this reporter.']}


def cell(value):
    if value is None:
        return '未知 / 不适用'
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, allow_nan=False)
    return str(value).replace('|', '&#124;').replace('\n', '<br>').replace('\r', '')


def link(root, path, title):
    return '[' + title + '](' + os.path.relpath(path, root).replace(' ', '%20') + ')'


def question_report(root, row):
    item = row['input']
    lines = ['# ' + row['id'] + ' / ' + row['subset'], '', '## 完整问题 / 参考答案 / 原始答案',
             old_report.fenced({key: item[key] for key in ('question_en', 'question_zh', 'reference_answer', 'model_answer')}),
             '', link(root / 'question-reports', row['originalAnswer']['path'], '原始完整答案记录'),
             '', '## 两套独立判分（不从分数推导严格正确）', '',
             '| 裁判 | 严格正确 | 严格理由 | final_answer | guess | hedged | 1–10 分 | 新理由 |',
             '|---|---|---|---|---|---|---:|---|']
    for label in JUDGES:
        old = row['strict'][label]['verdict'] or {}
        new = row['scores'][label]['verdict'] or {}
        lines.append('| ' + ' | '.join(map(cell, (label, old.get('correct'), old.get('reason'), old.get('final_answer'),
                     old.get('guess'), old.get('hedged'), new.get('score'), new.get('reason')))) + ' |')
    lines += ['', '## 可追溯文件链接']
    for name, evidence in row['datasetEvidence'].items():
        lines.append('- ' + link(root / 'question-reports', evidence['path'], name) + ' — SHA256 `' + evidence['sha256'] + '`')
    for kind in ('strict', 'scores'):
        for label in JUDGES:
            record = row[kind][label]
            lines.append('- ' + link(root / 'question-reports', record['path'], kind + ' / ' + label) + ' — ' + record['status'] + ' / SHA256 `' + str(record['sha256']) + '`')
            for attempt in record['attempts']:
                lines.append('  - ' + link(root / 'question-reports', attempt['path'], 'attempt ' + str(attempt['attempt'])) + ' — SHA256 `' + attempt['sha256'] + '`')
    lines += ['', '## 精确路径 / 字节指纹 / 旧诊断 / 新尝试', old_report.fenced(row), '']
    return '\n'.join(lines)


def render_report(data):
    lines = ['# Immutable LME16 — 1–10 grading supplement', '', 'State: **' + data['state'] + '**',
             'Run: ' + data['run'], 'Original: ' + data['originalRun'],
             'Fingerprint: `' + data['fingerprint'] + '`; original: `' + data['originalFingerprint'] + '`',
             'Selected: ' + str(data['selectedCount']) + '/16; ' + data['originalIdentity']['dataset'] + ' answers; DEV8 / hard8.',
             *data['notes'], '', '## 身份与判分口径',
             old_report.fenced({'supplement': {key: data['identity'].get(key) for key in ('task', 'arm', 'judges', 'promptSha256', 'rule', 'inputPolicy', 'resourcePolicy')},
                               'original': data['originalIdentity'], 'snapshotCount': len(data['originalSnapshots']),
                               'snapshotType': 'reused native-live final-segment snapshot; no reload'}),
             '[Complete identity / file-hash inventory](manifest.json) · [Snapshot and evidence inventory](aggregate.json)',
             '', '## 表一：原始严格对错（judge v2）', '',
             '| 裁判 / effort | 分组 | 所选 | 有效 | 正确 | 错误 | 正确率 | 正确率分母 | 覆盖率 | 失败 | 缺失 | 待完成 |',
             '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for label in JUDGES:
        effort = data['originalIdentity']['models']['judges'][label]['effort']
        for group in GROUPS:
            s = data['strict'][label][group]
            lines.append('| ' + ' | '.join(map(cell, (label + ' / ' + str(effort), group, *(s[k] for k in
                          ('selected', 'scored', 'correct', 'wrong', 'accuracy', 'accuracyDenominator', 'coverage', 'failed', 'missing', 'pending'))))) + ' |')
    lines += ['', '## 表二：1–10 总分与平均分', '',
              '| 裁判 / effort | 分组 | 所选 | 有效 | 总分 | 有效满分 | 平均分 /10 | 均分分母 | 覆盖率（有效/所选） | 失败 | 缺失 | 待完成 |',
              '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for label in JUDGES:
        for group in GROUPS:
            s = data['scores'][label][group]
            lines.append('| ' + ' | '.join(map(cell, (label + ' / ' + data['identity']['judges'][label]['effort'], group,
                          *(s[k] for k in ('selected', 'scored', 'totalScore', 'effectiveMax', 'mean', 'meanDenominator', 'coverage', 'failed', 'missing', 'pending'))))) + ' |')
    lines += ['', 'Provider / parse / answer failures are separated in [quality table JSON](scores-table.json); missing and pending remain independently unscored.']
    lines += ['', '## 表三：资源消耗（OLD 与 NEW 分开）', '',
              '| 阶段 / 范围 | 指标 | 实测值 | 单位 / 统计口径 | 覆盖 / 证据 |', '|---|---|---|---|---|']
    for row in data['resources']['rows']:
        lines.append('| ' + ' | '.join(cell(row[k]) for k in ('stage', 'metric', 'value', 'unit', 'evidence')) + ' |')
    lines += ['', '## 逐题并排与完整证据', '',
              '| 题目 | 分组 | Luna 严格 | Luna 分数 / 理由 | Sol 严格 | Sol 分数 / 理由 |', '|---|---|---|---|---|---|']
    for row in data['perQuestion']:
        values = ['[' + row['id'] + '](question-reports/' + row['id'] + '.md)', row['subset']]
        for label in JUDGES:
            old, new = row['strict'][label], row['scores'][label]
            values += [str(old['verdict']['correct']) if old['verdict'] else old['status'],
                       str(new['verdict']['score']) + ' / ' + new['verdict']['reason'] if new['verdict'] else new['status']]
        lines.append('| ' + ' | '.join(map(cell, values)) + ' |')
    lines += ['', '## 验证与覆盖', old_report.fenced({'verification': data['verification'],
              'originalFilesChecked': len(data['originalFilesChecked']), 'inputFilesChecked': len(data['inputFilesChecked'])}),
              '[Full immutable inventory](manifest.json)', '']
    return '\n'.join(lines)


def write_report(root):
    data = load_report(root)
    root = Path(root).resolve()
    directory = bounded(root, 'question-reports')
    directory.mkdir(exist_ok=True)
    for row in data['perQuestion']:
        bounded(root, directory / (row['id'] + '.md')).write_text(question_report(root, row), encoding='utf-8')
    for name, value in (('aggregate', data), ('strict-table', data['strict']), ('scores-table', data['scores']),
                        ('resources-table', data['resources'])):
        bounded(root, name + '.json').write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    bounded(root, 'REPORT.md').write_text(render_report(data), encoding='utf-8')
    return data


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    args = parser.parse_args()
    data = write_report(args.run)
    print(json.dumps({'state': data['state'], 'selected': data['selectedCount']}, ensure_ascii=False))
