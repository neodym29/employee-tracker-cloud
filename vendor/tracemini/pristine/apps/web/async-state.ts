export function canApplyWorkspaceResult(
  expectedWorkspaceId: number,
  currentWorkspaceId: number,
  mounted: boolean,
  expectedGeneration?: number,
  currentGeneration?: number,
) {
  const generationMatches = expectedGeneration === undefined || currentGeneration === undefined || expectedGeneration === currentGeneration;
  return mounted && expectedWorkspaceId === currentWorkspaceId && generationMatches;
}
