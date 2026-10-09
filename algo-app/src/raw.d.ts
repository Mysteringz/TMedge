/** Keep the downloadable Python example and the editor's starter identical. */
declare module '*.py?raw' {
  const source: string;
  export default source;
}
