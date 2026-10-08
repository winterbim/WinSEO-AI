export interface WorkspaceOption {
  id: string;
  name: string;
}

export type WorkspaceChoice =
  { kind: "create" } | { kind: "choose" } | { kind: "selected"; workspace: WorkspaceOption };

export function resolveWorkspaceChoice(
  workspaces: WorkspaceOption[],
  selectedId: string,
): WorkspaceChoice {
  if (workspaces.length === 0) return { kind: "create" };
  const soleWorkspace = workspaces.at(0);
  if (workspaces.length === 1 && soleWorkspace) {
    return { kind: "selected", workspace: soleWorkspace };
  }

  const workspace = workspaces.find((candidate) => candidate.id === selectedId);
  return workspace ? { kind: "selected", workspace } : { kind: "choose" };
}
