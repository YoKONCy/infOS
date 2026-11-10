/** @platform ELECTRON 家的实时事件；凭据只保留在主进程。 */
import { getBackendOrigin } from '../services/clientConnection'
import { getClientCredential } from '../utils/clientCredential'
import { HomeEventsClient, type HomeEventData, type HomeEventType } from './homeEventsCore'

const client = new HomeEventsClient({
  origin: getBackendOrigin,
  credential: getClientCredential,
  request: (...args) => fetch(...args),
})

export function onHomeEvent<T extends HomeEventType>(
  type: T,
  handler: (data: HomeEventData<T>) => void,
): () => void {
  return client.on(type, handler)
}

export function startHomeEvents(): void {
  client.start()
}

export function stopHomeEvents(): void {
  client.stop()
}
