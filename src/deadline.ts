/** ACP cancellation is cooperative. This deadline also rejects locally so the
 * executor's finally block closes the transport and stops its process group. */
export async function withDeadline<T>(
  operation: Promise<T>,
  ms: number,
  code: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
