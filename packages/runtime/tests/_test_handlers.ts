// Named export for onMount test
export function onMount(_state: any) {
  (globalThis as any)._testMounted = true;
}
