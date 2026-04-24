import { ProjectMessageResponseSchema } from '../api/base';
import {
    ChatMessageDeliveryDetail,
    ChatMessageDeliveryState,
} from './chatMessageDelivery';

export interface ChatViewMessageSchema extends ProjectMessageResponseSchema {
    deliveryDetail?: ChatMessageDeliveryDetail,
    deliveryState?: ChatMessageDeliveryState,
}

export function normalizeChatMessage(message: ProjectMessageResponseSchema): ChatViewMessageSchema {
    return {
        ...message,
    };
}
