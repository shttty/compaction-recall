export default async function(pi) {
  const modulePath = process.env.PI_RECALL_EXTENSION;
  if (!modulePath) throw new Error('PI_RECALL_EXTENSION must point to the pinned candidate');
  const { default: register } = await import(modulePath);
  register({
    // Suppress all recall lifecycle/context hooks; this arm never starts an index.
    on() {},
    registerTool(tool) {
      if (tool.name === 'history_grep' || tool.name === 'history_expand') pi.registerTool(tool);
    },
  });
}
