export interface PackageShare { shareId: string; draftId: string; title: string; ownerId: string; createdAt: string; updatedAt: string; deletedAt: string | null }
export interface PackageScope { kind: 'all' | 'selected-episodes'; episodeIds: string[]; sourceEpisodeCount: number; assetOrigins?: Array<{ assetId: string; episodeId?: string; sourceEpisodeIds?: string[]; validFrom?: string; validUntil?: string }> }
export interface PackageMediaFact { sha256: string; size: number; mime: string; kind: string }
export interface PackageVersion { versionId: string; shareId: string; sequence: number; draftId: string; sourceDraftId: string; title: string; size: number; sha256: string; publishedBy: string; createdAt: string; scope: PackageScope | null; scopeSummary?: { kind: 'all' | 'selected-episodes'; episodeCount: number; sourceEpisodeCount: number }; scopePageAvailable?: boolean; scopeBytes?: number; scopeDigest?: string; scopeChunks?: number; baseVersionId: string | null; downloadAvailable: boolean; kind: 'zip' | 'manifest'; snapshot?: { sha256: string; size: number }; media?: PackageMediaFact[]; mediaCount?: number; mediaDigest?: string; mediaPageAvailable?: boolean }

export interface PackageVersionInput {
  requestId: string; draftId: string; title: string; size: number; sha256: string;
  scope: PackageScope; baseVersionId: string | null; url: string;
}
export interface PackageManifestInput {
  kind: 'manifest'; requestId: string; draftId: string; title: string; scope: PackageScope; baseVersionId: string | null;
  snapshot: { url: string; sha256: string; size: number }; media: PackageMediaFact[];
}
export interface PackageScopeTransfer { bytes: number; sha256: string; chunks: number }
export interface PackageManifestStageInput extends Omit<PackageManifestInput, 'media' | 'scope'> { scope?: PackageScope; scopeTransfer?: PackageScopeTransfer; mediaCount: number; mediaDigest?: string }
export interface PackageMediaClaim {
  claimId: string; shareId: string; sha256: string; size: number; actorId: string; requestId: string;
  repair: number; status: 'active' | 'completed' | 'cancelled' | 'expired'; leaseUntil: string;
}
