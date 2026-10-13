export interface PackageStoragePart { partNumber: number; etag: string; size: number }
export interface PackageStorage {
  kind: string;
  allowedStorageHosts?: readonly string[];
  multipartLimits: { minPartBytes: number; maxPartBytes: number; maxParts: number; maxObjectBytes?: number };
  begin(input: { objectKey: string; size: number; sha256: string; contentType: 'application/zip' }, signal?: AbortSignal): Promise<{ uploadId: string }>;
  signPart(input: { objectKey: string; uploadId: string; partNumber: number; size: number; md5Base64: string }, signal?: AbortSignal): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }>;
  listParts(input: { objectKey: string; uploadId: string }, signal?: AbortSignal): Promise<PackageStoragePart[]>;
  complete(input: { objectKey: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }> }, signal?: AbortSignal): Promise<void>;
  abort(input: { objectKey: string; uploadId: string }, signal?: AbortSignal): Promise<void>;
  head(objectKey: string, signal?: AbortSignal): Promise<{ size: number; metadata: { sha256: string } } | null>;
  signDownload(input: { objectKey: string; filename: string }, signal?: AbortSignal): Promise<{ url: string; headers?: Record<string, string>; expiresAt: string }>;
}
export interface PackageShare { shareId: string; draftId: string; title: string; ownerId: string; createdAt: string; updatedAt: string; deletedAt: string | null }
export interface PackageScope { kind: 'all' | 'selected-episodes'; episodeIds: string[]; sourceEpisodeCount: number; assetOrigins?: Array<{ assetId: string; episodeId?: string; sourceEpisodeIds?: string[]; validFrom?: string; validUntil?: string }> }
export interface PackageVersion { versionId: string; shareId: string; sequence: number; draftId: string; sourceDraftId: string; title: string; size: number; sha256: string; publishedBy: string; createdAt: string; scope: PackageScope; baseVersionId: string | null }
export interface PackageUpload {
  uploadId: string; shareId: string; actorId: string; requestId: string; objectKey: string;
  storageUploadId: string | null; draftId: string; title: string; size: number; sha256: string;
  partSize: number; partCount: number; status: 'initializing' | 'uploading' | 'completed' | 'cancelled';
  createdAt: string; expiresAt: string; versionId: string | null;
  scope: PackageScope; baseVersionId: string | null;
  initializationToken: string | null; initializationUntil: number | null;
}
