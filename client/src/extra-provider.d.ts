// `$extra` resolves at build time to the VITE_CANVAS_EXTRA module (vite.config.ts), else ./extra.ts.
declare module '$extra' {
  const extra: import('./extra').CanvasExtra;
  export default extra;
}
