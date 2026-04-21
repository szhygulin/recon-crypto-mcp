const FOURBYTE_URL = "https://www.4byte.directory/api/v1/signatures/";

export type FetchLike = (input: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const defaultFetch: FetchLike = (url) => fetch(url);

export async function fetch4byteSignatures(
  selector: string,
  fetchFn: FetchLike = defaultFetch
): Promise<string[]> {
  const res = await fetchFn(`${FOURBYTE_URL}?hex_signature=${selector}`);
  if (!res.ok) throw new Error(`4byte.directory returned ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ text_signature: string }> };
  return (data.results ?? []).map((r) => r.text_signature);
}
