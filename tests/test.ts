import nodeTest, { type TestFn } from "node:test";

export function test(name: string, fn: TestFn): void {
  void nodeTest(name, fn);
}

// Development helpers for temporarily skipping or focusing tests; unused exports are intentional.
export function skip(name: string, fn: TestFn): void {
  void nodeTest.skip(name, fn);
}

export function only(name: string, fn: TestFn): void {
  void nodeTest.only(name, fn);
}
