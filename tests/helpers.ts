/** Collects writes into an array and exposes the joined text. */
export interface OutputSink {
  write: (text: string) => void;
  chunks: string[];
  text: () => string;
}

export function createSink(): OutputSink {
  const chunks: string[] = [];
  return {
    write: (text: string) => {
      chunks.push(text);
    },
    chunks,
    text: () => chunks.join(""),
  };
}
