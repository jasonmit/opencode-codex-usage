import nodeTest, { type TestFn } from "node:test";

export function test(name: string, fn: TestFn): void {
  void nodeTest(name, fn);
}

export function skip(name: string, fn: TestFn): void {
  void nodeTest.skip(name, fn);
}

export function only(name: string, fn: TestFn): void {
  void nodeTest.only(name, fn);
}
