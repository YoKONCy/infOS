/** @platform ELECTRON 主进程访问 /api/home；凭据只保留在主进程。 */
import { getBackendOrigin } from '../services/clientConnection'
import { getClientCredential } from '../utils/clientCredential'
import { createHomeApi } from './homeApiCore'

export { HomeApiError, type HomeApiCall } from './homeApiCore'

export const homeApi = createHomeApi({
  origin: getBackendOrigin,
  credential: getClientCredential,
  request: (...args) => fetch(...args),
})
