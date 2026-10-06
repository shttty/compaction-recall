// Solver-facing adapter: only production context hook and registered tool execute functions.
import register from '../src/index.ts';

export function buildBlindCorpus(questions) {
  const entries = [];
  const prompts = new Map();
  for (const question of questions) {
    // Explicit allowlist: never carry answer, answer_session_ids or has_answer into context.
    prompts.set(question.question_id, { id: question.question_id, question: question.question, questionDate: question.question_date });
    const sessions = question.haystack_sessions.map((turns, i) => ({ turns, date: question.haystack_dates[i] }))
      .sort((a, b) => a.date.replace(/ \(\w+\)/, '').localeCompare(b.date.replace(/ \(\w+\)/, '')));
    let seq = 0;
    for (const session of sessions) {
      const turns = session.turns.map(turn => ({ role: turn.role, content: turn.content }));
      if (!turns.length) continue;
      if (turns[0].role === 'user') turns[0].content = `[Session Date: ${session.date}]\n${turns[0].content}`;
      else turns.unshift({ role: 'user', content: `[Session Date: ${session.date}]` });
      const base = Date.parse(session.date.replace(/ \(\w+\)/, '').replaceAll('/', '-').replace(' ', 'T') + ':00Z');
      for (const turn of turns) {
        const id = `${question.question_id}:${(++seq).toString(16).padStart(8, '0')}`;
        const timestamp = new Date(base + seq * 1000).toISOString();
        entries.push({
          type: 'message', id, parentId: entries.at(-1)?.id ?? null, timestamp,
          message: { role: turn.role, content: [{ type: 'text', text: turn.content }], timestamp: Date.parse(timestamp) }
        });
      }
    }
  }
  const tail = {
    type: 'message', id: 'retained:tail', timestamp: '2026-09-30T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'retained tail' }], timestamp: 0 }
  };
  const branch = [...entries, tail, {
    type: 'compaction', id: 'blind-simulated-final', timestamp: tail.timestamp,
    firstKeptEntryId: tail.id, summary: '', tokensBefore: 0
  }];
  return { branch, prompts };
}

export function createBlindHarness(questions) {
  const { branch, prompts } = buildBlindCorpus(questions);
  const tools = new Map(), hooks = new Map();
  register({
    registerTool(tool) { tools.set(tool.name, tool); }, on(event, handler) {
      hooks.set(event, handler);
    }
  });
  const ctx = { sessionManager: { getBranch: () => branch.slice() } };
  return {
    async dispose() { await hooks.get('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, ctx); },
    async start(id) {
      const prompt = prompts.get(id);
      if (!prompt) throw new Error('Unknown question');
      const result = await hooks.get('context')({ type: 'context', messages: [{ role: 'user', content: [{ type: 'text', text: prompt.question }], timestamp: 0 }] }, ctx);
      return {
        ...prompt, automaticLocators: result.messages.filter(m => m.role === 'custom').map(m => m.content),
        tools: [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      };
    },
    async execute(name, parameters) {
      const tool = tools.get(name);
      if (!tool) throw new Error('Only history_recall, history_expand and history_grep are available');
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Parameters must be an object');
      if (name !== 'history_recall') {
        const required = name === 'history_grep' ? 'pattern' : 'id';
        if (typeof parameters[required] !== 'string') throw new Error(`${required} must be a string`);
      }
      if (name === 'history_expand') for (const field of ['before', 'after']) {
        if (parameters[field] !== undefined && (!Number.isInteger(parameters[field]) || parameters[field] < 0 || parameters[field] > 20)) throw new Error(`${field} must be an integer from 0 to 20`);
      }
      return tool.execute('blind-simulation', parameters, undefined, undefined, ctx);
    },
  };
}
