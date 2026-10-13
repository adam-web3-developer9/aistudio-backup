export interface PackageShare { shareId: string; draftId: string; title: string; ownerId: string; createdAt: string; updatedAt: string; deletedAt: string | null }
export interface PackageScope { kind: 'all' | 'selected-episodes'; episodeIds: string[]; sourceEpisodeCount: number; assetOrigins?: Array<{ assetId: string; episodeId?: string; sourceEpisodeIds?: string[]; validFrom?: string; validUntil?: string }> }
export interface PackageVersion { versionId: string; shareId: string; sequence: number; draftId: string; sourceDraftId: string; title: string; size: number; sha256: string; publishedBy: string; createdAt: string; scope: PackageScope; baseVersionId: string | null; downloadAvailable: boolean }

export interface PackageVersionInput {
  requestId: string; draftId: string; title: string; size: number; sha256: string;
  scope: PackageScope; baseVersionId: string | null; url: string;
}
