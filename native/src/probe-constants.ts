import protocolPolicy from "../server/protocol-policy.json";

export const MAX_PARTICIPANTS_PER_ROOM =
  protocolPolicy.maxParticipantsPerRoom;

export const NETWORK_PROBE_CHUNK_BYTES =
  protocolPolicy.networkProbe.version1.chunkBytes;
export const NETWORK_PROBE_MAX_CHUNKS =
  protocolPolicy.networkProbe.version1.maximumChunks;
export const NETWORK_PROBE_V2_CHUNK_BYTES =
  protocolPolicy.networkProbe.version2.chunkBytes;
export const NETWORK_PROBE_V2_MAX_CHUNKS =
  protocolPolicy.networkProbe.version2.maximumChunks;
