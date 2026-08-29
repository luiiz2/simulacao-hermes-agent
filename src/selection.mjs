// Explicit setup policy for project and model selection.

export function missingSelection(chat, resolvedModel) {
  if (!(chat?.modelOverride || chat?.modelSelected === true) || !resolvedModel) return "model";
  return null;
}
