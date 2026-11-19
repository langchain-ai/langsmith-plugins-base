import type {
  LangSmithUploadDestinationConfig,
  LangSmithUploadReplicaConfig,
  LangSmithUploadWriterOptions,
} from "../../tracing/upload/models.js";

function withoutKey<T extends { apiKey?: string }>(config: T): T {
  const copy = { ...config };
  delete copy.apiKey;
  return copy;
}

export function withoutCredentials(
  writer: LangSmithUploadWriterOptions,
): LangSmithUploadWriterOptions {
  return {
    ...writer,
    destinations: writer.destinations.map(withoutKey),
    ...(writer.replicas ? { replicas: writer.replicas.map(withoutKey) } : {}),
  };
}

function destinationWithKey(
  destination: LangSmithUploadDestinationConfig,
  credentials: LangSmithUploadWriterOptions,
): LangSmithUploadDestinationConfig {
  const apiKey = credentials.destinations[0]?.apiKey;
  return destination.login || !apiKey ? destination : { ...destination, apiKey };
}

function replicaWithKey(
  replica: LangSmithUploadReplicaConfig,
  credentials: LangSmithUploadWriterOptions,
): LangSmithUploadReplicaConfig {
  const apiKey = credentials.replicas?.find(({ apiUrl }) => apiUrl === replica.apiUrl)?.apiKey;
  return apiKey ? { ...replica, apiKey } : replica;
}

export function withCredentials(
  writer: LangSmithUploadWriterOptions,
  credentials: LangSmithUploadWriterOptions,
): LangSmithUploadWriterOptions {
  return {
    ...writer,
    destinations: writer.destinations.map((destination) =>
      destinationWithKey(destination, credentials),
    ),
    ...(writer.replicas
      ? { replicas: writer.replicas.map((replica) => replicaWithKey(replica, credentials)) }
      : {}),
  };
}
