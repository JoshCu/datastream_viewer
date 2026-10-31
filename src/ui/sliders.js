// ====================================================================
// Range inputs bound to a key of a settings object (flowState,
// erosionState), each with a `${id}Value` label. Binding the same key from
// two panels keeps their sliders in step.
// ====================================================================

const bound = new Map(); // settings -> Map(key -> [{ input, label, fmt }])

// `fmt` labels the value; `apply` reacts to a change (from either slider).
export function bindSlider(settings, id, key, fmt, apply) {
  const input = document.getElementById(id);
  const label = document.getElementById(`${id}Value`);
  if (!bound.has(settings)) bound.set(settings, new Map());
  const byKey = bound.get(settings);
  if (!byKey.has(key)) byKey.set(key, []);
  const peers = byKey.get(key);
  const me = { input, label, fmt };
  peers.push(me);
  input.value = settings[key];
  label.textContent = fmt(settings[key]);
  input.addEventListener("input", () => {
    settings[key] = Number(input.value);
    for (const b of peers) {
      if (b !== me) b.input.value = settings[key];
      b.label.textContent = b.fmt(settings[key]);
    }
    apply?.();
  });
}
