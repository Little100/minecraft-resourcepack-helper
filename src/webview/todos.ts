import { createBus } from './bus'
import { mountTodoView } from './todoView'
const bus = createBus()
mountTodoView(document.body, message => bus.post(message))
