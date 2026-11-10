import type { HomeScope } from '@infos/shared'
import type { z } from 'zod'
import type { HomeService } from './homeService'
import { HomeError } from './homeErrors'
import type { homeCardSchema, homeFileSchema, homeMapSchema, homeShelfSchema } from './homeSchemas'

export function homeFileCommand(
  home: HomeService,
  scope: HomeScope,
  input: z.infer<typeof homeFileSchema>,
) {
  switch (input.action) {
    case 'read':
      return home.files.read(scope, input.path)
    case 'list':
      return home.files.list(scope, input.path)
    case 'search':
      if (!input.query) throw new HomeError('HOME_INVALID')
      return home.files.search(scope, input.path, input.query)
    case 'write':
      if (input.content === undefined) throw new HomeError('HOME_INVALID')
      return home.files.mutate(
        scope,
        'write',
        input.path,
        Buffer.from(input.content, input.encoding),
      )
    case 'move':
      if (!input.destination) throw new HomeError('HOME_INVALID')
      return home.files.mutate(scope, 'move', input.path, undefined, input.destination)
    case 'delete':
      return home.files.mutate(scope, 'delete', input.path)
  }
}
export function homeShelfCommand(
  home: HomeService,
  scope: HomeScope,
  input: z.infer<typeof homeShelfSchema>,
  from: 'user' | 'agent',
) {
  switch (input.action) {
    case 'list':
      return home.belongings.shelf(scope.agentId, input.includeDeleted)
    case 'put': {
      if (!input.kind || !input.name) throw new HomeError('HOME_INVALID')
      const content = input.path
        ? Buffer.from(home.files.read(scope, input.path).content, 'base64')
        : input.content === undefined
          ? undefined
          : Buffer.from(input.content, 'base64')
      return home.belongings.putShelf(scope.agentId, from, {
        kind: input.kind,
        name: input.name,
        value: input.value,
        content,
      })
    }
    case 'take':
      if (!input.id) throw new HomeError('HOME_INVALID')
      return home.belongings.takeShelf(scope.agentId, input.id)
    case 'delete':
      if (!input.id) throw new HomeError('HOME_INVALID')
      return home.belongings.deleteShelf(scope.agentId, input.id)
    case 'restore':
      if (!input.id) throw new HomeError('HOME_INVALID')
      return home.belongings.restoreShelf(scope.agentId, input.id)
  }
}
export function homeMapCommand(
  home: HomeService,
  scope: HomeScope,
  input: z.infer<typeof homeMapSchema>,
) {
  if (input.action === 'list')
    return home.belongings.map(scope.agentId, input.query, input.includeDeleted)
  if (input.action === 'restore') {
    if (!input.id) throw new HomeError('HOME_INVALID')
    return home.belongings.restoreMap(scope.agentId, input.id)
  }
  if (input.action === 'get') {
    const value = home.belongings.map(scope.agentId).find((row) => row.id === input.id)
    if (!value) throw new HomeError('HOME_NOT_FOUND')
    return value
  }
  if (input.action === 'delete') {
    if (!input.id) throw new HomeError('HOME_INVALID')
    return home.belongings.deleteMap(scope.agentId, input.id)
  }
  if (!input.kind || !input.name || !input.location || input.purpose === undefined)
    throw new HomeError('HOME_INVALID')
  return home.belongings.putMap(scope.agentId, {
    id: input.id,
    kind: input.kind,
    name: input.name,
    location: input.location,
    purpose: input.purpose,
  })
}
export function homeCardCommand(
  home: HomeService,
  scope: HomeScope,
  input: z.infer<typeof homeCardSchema>,
) {
  if (input.action === 'messages') return home.cards.messages(scope)
  if (input.action === 'ack') {
    if (!input.messageId) throw new HomeError('HOME_INVALID')
    home.cards.acknowledge(scope, input.messageId)
    return { acknowledged: input.messageId }
  }
  if (!input.cardId) throw new HomeError('HOME_INVALID')
  if (input.action === 'get') return home.cards.get(scope, input.cardId)
  if (input.revision === undefined || !input.data) throw new HomeError('HOME_INVALID')
  return home.cards.patch(scope, input.cardId, input.revision, input.data)
}
