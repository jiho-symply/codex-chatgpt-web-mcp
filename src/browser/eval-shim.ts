export const EVALUATE_NAME_SHIM = String.raw`
(() => {
  if (typeof globalThis.__name === "function") return;
  Object.defineProperty(globalThis, "__name", {
    configurable: true,
    writable: true,
    value: (target) => target,
  });
})();
`;
