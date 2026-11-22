import { createBus } from './bus'
import { mountGitView } from './gitView'
const bus = createBus()
mountGitView(document.body, message => bus.post(message))
