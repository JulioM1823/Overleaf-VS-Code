<script setup lang="ts">
    import { useElementVisibility } from '@vueuse/core';
    import { computed, inject, ref, type Ref, watchEffect } from 'vue';
    import InputBox from './InputBox.vue';
    import { deleteMessage, type Message } from '../utils';
    import { formatOverleafTimestamp } from '../../../../src/utils/overleafTimestamp';

    const props = defineProps<{
        message: Message,
        now: number,
        userId: string,
    }>();

    const isFocused = ref(false);
    const container = ref<HTMLDivElement>();
    const editing = ref(false);
    const activeInputBox = inject('activeInputBox');
    const unreadRecord = inject('unreadRecord') as Ref<string[]>;

    const username = computed(() => {
        return `${props.message.user.first_name} ${props.message.user.last_name || ''}`.trim();
    });
    const formatTimestamp = computed(() => {
        return formatOverleafTimestamp(props.message.timestamp, new Date(props.now)) ?? '';
    });
    const deliveryLabel = computed(() => {
        if (props.message.deliveryState!=='pending') {
            return '';
        }
        return props.message.deliveryDetail==='queued' ? 'Queued' : 'Sending...';
    });
    const isOwnMessage = computed(() => props.message.user.id===props.userId);
    const canMutate = computed(() => {
        return isOwnMessage.value && props.message.deliveryState!=='pending';
    });
    const showEdited = computed(() => Boolean(props.message.edited_at));

    const containerVisible = useElementVisibility(container);
    watchEffect(() => {
        if (containerVisible.value && props.message.newMessage) {
            props.message.newMessage = false;
            const index = unreadRecord.value.indexOf(props.message.id);
            if (index >= 0) {
                unreadRecord.value.splice(index, 1);
            }
        }
    });

    function beginEdit() {
        editing.value = true;
    }

    function finishEdit() {
        editing.value = false;
    }

    function handleDelete() {
        deleteMessage(props.message.id);
    }

    function focus() {
        setTimeout(() => {
            container.value?.focus();
        }, 10);
    }

    function scrollIntoView() {
        container.value?.scrollIntoView({behavior: 'instant', block: 'nearest'});
        container.value?.classList.add('showup');
        setTimeout(() => {
            container.value?.classList.remove('showup');
        }, 500);
    }

    function insertMention() {
        const text = `@${username.value} `;
        (activeInputBox as Ref<any>).value.value.insertText(text);
    }

    defineExpose({
        scrollIntoView,
        focus,
        isFocused,
    });
</script>

<template>
    <div
        ref="container"
        role="listitem"
        class="message-item"
        tabindex="0"
        :aria-label="`${username} said ${formatTimestamp}: ${props.message.content}`"
        :aria-selected="isFocused"
        @focus="isFocused=true"
        @focusout="isFocused=false"
    >
        <div class="message-item_header">
            <button class="message-item_author" type="button" @click="insertMention">{{ username }}</button>
            <span class="message-item_header_date" :title="new Date(props.message.timestamp).toLocaleString()">{{ formatTimestamp }}</span>
            <span v-if="showEdited" class="message-item_meta">Edited</span>
            <span v-if="deliveryLabel" class="message-item_delivery_state">{{ deliveryLabel }}</span>
        </div>
        <div v-if="!editing" class="message-item_content">{{ props.message.content }}</div>
        <div v-else class="message-item_edit">
            <InputBox
                mode="edit"
                :initialText="props.message.content"
                :messageId="props.message.id"
                placeholder="Update message..."
                @submitted="finishEdit"
            />
        </div>
        <div v-if="canMutate" class="message-item_actions">
            <vscode-button appearance="icon" aria-label="Edit message" @click="beginEdit">
                <span class="codicon codicon-edit"></span>
            </vscode-button>
            <vscode-button appearance="icon" aria-label="Delete message" @click="handleDelete">
                <span class="codicon codicon-trash"></span>
            </vscode-button>
        </div>
    </div>
</template>

<style scoped>
    .message-item {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        width: 100%;
        padding: 4px 0;
    }

    .message-item_header {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
        width: 100%;
    }

    .message-item_author {
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--vscode-editor-foreground);
        cursor: pointer;
        font: inherit;
        font-weight: 700;
    }

    .message-item_header_date,
    .message-item_meta,
    .message-item_delivery_state {
        font-size: 0.8rem;
        color: var(--vscode-descriptionForeground);
    }

    .message-item_delivery_state {
        margin-left: auto;
        padding: 0.1rem 0.45rem;
        border: 1px solid var(--vscode-inputOption-activeBorder);
        border-radius: 999px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .message-item_content {
        width: 100%;
        margin-top: 4px;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .message-item_actions {
        display: flex;
        justify-content: flex-end;
        gap: 4px;
        margin-top: 6px;
    }

    .message-item_edit {
        width: 100%;
        margin-top: 6px;
    }

    .showup {
        width: 98%;
        border: 2px solid var(--vscode-focusBorder);
        border-radius: 2px;
        transition: border-color 0.5s ease-in;
    }
</style>
