import { lstat } from "node:fs/promises";

const isNotFoundError = (error: unknown): boolean => {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
};

export const lstatIfExists = async (
  targetPath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(targetPath);
  } catch (error: unknown) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
};
