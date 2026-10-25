export type EditableResourceKind = 'skills' | 'custom' | 'agents' | 'packages'
export interface ResourceRevision {
  id: string
  kind: EditableResourceKind
  createdAt: string
  appliedAt?: string
  candidateDirectory: string
  state: 'draft' | 'pending' | 'applied' | 'rolled-back'
  baseDigest: string
  digest?: string
}
export interface ResourceVersionsView {
  safeMode: boolean
  interrupted: boolean
  restartRequired?: boolean
  revisions: ResourceRevision[]
  pending: Array<{ id: string; action: 'apply' | 'rollback' }>
}
