export default async function(pi) {
  const modulePath = process.env.PI_RECALL_EXTENSION;
  if (!modulePath) throw new Error('PI_RECALL_EXTENSION must point to the pinned candidate');
  const { default: register } = await import(modulePath);
  register({
    on(event) {
      if (event !== 'context') throw new Error(`Unexpected extension event: ${event}`);
    },
    registerTool(tool) {
      if (tool.name === 'history_grep' || tool.name === 'history_expand') pi.registerTool(tool);
    },
  });
}
