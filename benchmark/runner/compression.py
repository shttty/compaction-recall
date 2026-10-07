"""Offline package compaction at the three proven chronological native cut points."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import uuid
from runner import artifacts as common
from runner import prepare as preparation, sdk


# Historical LME builder's diagnostic assistant usage; not SDK/provider usage.
HISTORY_CHARS_PER_TOKEN = 4.84

def projection(row):
    message = row['message']
    return row['id'], message['role'], message['content'], message['timestamp']


def corpus_projection(corpus):
    # Port of the verified LME build_session chronology/date-marker rendering.
    dated = sorted(((datetime.strptime(re.sub(r' \(\w+\)', '', date), '%Y/%m/%d %H:%M').replace(tzinfo=timezone.utc), date, turns)
                    for date, turns in zip(corpus['haystack_dates'], corpus['haystack_sessions']) if turns), key=lambda item: item[0])
    result, number = [], 0
    for when, label, turns in dated:
        turns = [dict(turn) for turn in turns]
        if turns[0]['role'] == 'user':
            turns[0]['content'] = '[Session Date: ' + label + ']\n' + turns[0]['content']
        else:
            turns.insert(0, {'role': 'user', 'content': '[Session Date: ' + label + ']'})
        for turn in turns:
            timestamp = int((when + timedelta(seconds=number)).timestamp() * 1000)
            number += 1
            result.append((f'{number:08x}', turn['role'], [{'type': 'text', 'text': turn['content']}], timestamp))
    return result


def source_history(native, corpus):
    rows = common.transcript(native)
    messages = [row for row in rows if row.get('type') == 'message']
    if [projection(row) for row in messages] != corpus_projection(corpus):
        raise ValueError('Source corpus/order/rendering differs from native snapshot')
    count, cuts = 0, [0]
    for row in rows:
        if row.get('type') == 'message':
            count += 1
        elif row.get('type') == 'compaction':
            cuts.append(count)
    cuts.append(count)
    if len(cuts) != 5 or any(left >= right for left, right in zip(cuts, cuts[1:])):
        raise ValueError('Requires three distinct native compaction cut points')
    # Native snapshots re-parent history and adjust diagnostic usage after each
    # cut. Restore the original linear source without changing message content.
    chars, parent = 0, None
    for row in messages:
        row['parentId'] = parent
        parent = row['id']
        message = row['message']
        chars += sum(len(block.get('text', '')) for block in message['content'])
        if message['role'] == 'assistant':
            message['usage']['input'] = message['usage']['totalTokens'] = int(chars / HISTORY_CHARS_PER_TOKEN)
    header = {**rows[0], 'id': str(uuid.uuid4())}
    return header, messages, cuts


def append_entries(session, messages):
    # Identical parent/estimated-usage adjustment to the verified harness helper.
    rows = common.transcript(session)
    parent = rows[-1]['id']
    base = next((row.get('tokensAfter') or 0 for row in reversed(rows) if row.get('type') == 'compaction'), 0)
    chars, appended = 0, []
    for original in messages:
        row = json.loads(json.dumps(original))
        row['parentId'] = parent
        parent = row['id']
        message = row['message']
        chars += sum(len(block.get('text', '')) for block in message['content'])
        if message['role'] == 'assistant':
            message['usage']['input'] = message['usage']['totalTokens'] = base + int(chars / HISTORY_CHARS_PER_TOKEN)
        appended.append(json.dumps(row, ensure_ascii=False))
    with session.open('a') as output:
        output.write('\n'.join(appended) + '\n')


def validate_compactions(rows, events):
    entries = [row for row in rows if row.get('type') == 'compaction']
    if len(entries) != 3 or len(events) != 3:
        raise ValueError('Package compression must provide exactly three compaction entries/events')
    if any(entry.get('fromHook') is not True or not isinstance(entry.get('summary'), str) or not entry['summary']
           or not entry.get('firstKeptEntryId') for entry in entries) or any(event.get('fromExtension') is not True for event in events):
        raise ValueError('Package must take over every explicit compaction without native fallback')
    return entries


def compress(output, config, pins, manifest, question, *, rpc_runner=None):
    if manifest['identity'].get('compressionMode') != 'package':
        return manifest['snapshots']['pi/' + question['id']]
    qid = question['id']
    folder = output / 'compression' / qid
    folder.mkdir(parents=True, exist_ok=True)
    native = manifest['identity']['snapshotSource']['snapshots']['pi/' + qid]
    native_path = Path(native['path'])
    preparation.verify_files({str(native_path): native['sha256']}, 'Native source snapshot')
    language = question['language']
    filename = 'corpus-zh.json' if language == 'zh' else 'corpus.json'
    corpus_path = next(Path(path) for path in manifest['identity']['inputs']
                       if Path(path).name == filename and Path(path).parent.name == qid)
    header, messages, cuts = source_history(native_path, json.loads(corpus_path.read_text()))
    original = common.transcript(native_path)
    source, session = folder / 'source.jsonl', folder / 'session.jsonl'
    if not source.exists():
        header['cwd'] = str(output / 'cwd')
        source.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in [header, *messages]) + '\n')
        source.chmod(0o400)
    elif [projection(row) for row in common.transcript(source)[1:]] != [projection(row) for row in messages]:
        raise ValueError('Frozen source history differs')
    home = output / 'homes' / qid
    identity = common.object_sha({'run': manifest['fingerprint'], 'qid': qid, 'source': common.sha(source), 'cuts': cuts})
    def operation():
        session.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in [common.transcript(source)[0], *messages[:cuts[1]]]) + '\n')
        session.chmod(0o600)
        compactions = []
        for stage in range(3):
            before = sdk.context_estimate(config, session)
            command = sdk.package_command(output, config, pins, folder, session, phase='compression', home=home, offline=True)
            observed = (rpc_runner or sdk.plain_rpc)(command, common.child_env(), folder,
                request={'id': 'compact', 'type': 'compact'}, timeout=900)
            if observed['rc'] != 0 or not observed.get('response', {}).get('success'):
                raise RuntimeError('Package offline compression failed; inspect compression phase evidence')
            entries = [row for row in common.transcript(session) if row.get('type') == 'compaction']
            if len(entries) != stage + 1 or entries[-1].get('fromHook') is not True:
                raise ValueError('Package did not supply the explicit compaction entry')
            events = common.transcript(folder / 'compaction-events.jsonl')
            if len(events) != stage + 1 or events[-1].get('fromExtension') is not True:
                raise ValueError('SDK compaction was not extension-provided')
            if (folder / 'wire-requests.jsonl').exists():
                raise ValueError('Package compression must make zero model requests')
            entry = entries[-1]
            compactions.append({'stage': stage + 1, 'seconds': observed['timing']['processWallMs'] / 1000,
                                'result': observed, 'entry': entry, 'summaryLength': len(entry['summary']),
                                'firstKeptEntryId': entry['firstKeptEntryId'], 'contextBefore': before,
                                'contextAfter': sdk.context_estimate(config, session), 'fromExtension': True})
            append_entries(session, messages[cuts[stage + 1]:cuts[stage + 2]])
        final = common.transcript(session)
        validate_compactions(final, common.transcript(folder / 'compaction-events.jsonl'))
        if [projection(row) for row in final if row.get('type') == 'message'] != [projection(row) for row in original if row.get('type') == 'message']:
            raise ValueError('Package snapshot changed source history')
        observed_cuts, count = [0], 0
        for row in final:
            if row.get('type') == 'message':
                count += 1
            elif row.get('type') == 'compaction':
                observed_cuts.append(count)
        if [*observed_cuts, count] != cuts:
            raise ValueError('Package compaction cut positions differ')
        return {'path': str(session), 'sha256': common.sha(session), 'sourcePath': str(source),
                'sourceSha256': common.sha(source), 'sourceMessagesMatched': True, 'cuts': cuts,
                'baselineCuts': cuts, 'compactions': compactions, 'home': str(home), 'modelRequests': 0,
                'sdkRegistration': str(folder / 'sdk-registration.json')}
    saved = common.durable_phase(folder, 'snapshot', identity, operation)
    preparation.verify_files({saved['path']: saved['sha256'], saved['sourcePath']: saved['sourceSha256']}, 'Package snapshot')
    manifest['snapshots']['pi/' + qid] = saved
    common.write_json(output / 'manifest.json', manifest)
    print(json.dumps({'phase': 'compression', 'language': language, 'id': qid, 'compactions': 3}), flush=True)
    return saved
