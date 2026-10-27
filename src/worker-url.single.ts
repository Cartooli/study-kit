// Single-file edition: the worker bundle is embedded as an inert <script type="text/plain">.
let url: string | undefined;
export const workerUrl = () => (url ??= URL.createObjectURL(new Blob([document.getElementById('sk-worker')!.textContent!], { type: 'text/javascript' })));
