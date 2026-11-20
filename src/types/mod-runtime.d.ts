/** The code-mod sandbox runtime as one script (built by the mod-runtime plugin in vite.config.ts). */
declare module 'virtual:deadboard-mod-runtime' {
  const code: string;
  export default code;
}
