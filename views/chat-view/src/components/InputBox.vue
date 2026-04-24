<script setup lang="ts">
    import { ref, type Ref, onMounted, computed, inject, onUnmounted } from 'vue';
    import { TextArea } from '@vscode/webview-ui-toolkit';
    import { editMessage, sendMessage } from '../utils';

    const props = defineProps<{
        initialText?: string,
        messageId?: string,
        mode?: 'compose' | 'edit',
        placeholder?: string,
    }>();
    const emit = defineEmits<{
        submitted: [],
    }>();
    defineExpose({
        focusInput,
        insertText,
    });

    const activeInputBox = inject('activeInputBox');
    const textAreaRef = ref<TextArea>();
    const placeholder = computed(() => {
        if (props.placeholder) {
            return props.placeholder;
        }
        return props.mode==='edit'
            ? 'Edit message...'
            : 'Send a message to your collaborators...';
    });

    onMounted(() => {
        if (!textAreaRef.value) {
            return;
        }
        const textAreaElement = textAreaRef.value.control as HTMLTextAreaElement;
        textAreaElement.style.borderRadius = '4px';
        textAreaElement.style.overflow = 'hidden';
        if (props.initialText) {
            textAreaElement.value = props.initialText;
            textAreaElement.selectionStart = props.initialText.length;
            textAreaElement.selectionEnd = props.initialText.length;
        }
        autoExpand();
    });

    onUnmounted(() => {
        (activeInputBox as Ref<any>).value = ref(undefined);
    });

    function setActive() {
        (activeInputBox as Ref<any>).value = ref({
            insertText,
        });
    }

    function insertText(text: string) {
        if (!textAreaRef.value) {
            return;
        }
        const textAreaElement = textAreaRef.value.control as HTMLTextAreaElement;
        const selectionStart = textAreaElement.selectionStart;
        const selectionEnd = textAreaElement.selectionEnd;
        const value = textAreaElement.value;
        textAreaElement.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
        textAreaElement.selectionStart = selectionStart + text.length;
        textAreaElement.selectionEnd = selectionStart + text.length;
        autoExpand();
        setTimeout(() => {
            textAreaElement.focus();
        }, 0);
    }

    function focusInput() {
        if (!textAreaRef.value) {
            return;
        }
        const textAreaElement = textAreaRef.value.control as HTMLTextAreaElement;
        setTimeout(() => {
            textAreaElement.focus();
        }, 0);
    }

    function autoExpand() {
        if (!textAreaRef.value) {
            return;
        }
        const textAreaElement = textAreaRef.value.control as HTMLTextAreaElement;
        textAreaElement.style.height = 'auto';
        textAreaElement.style.height = textAreaElement.scrollHeight + 'px';
    }

    function handleKeybinding(event: KeyboardEvent) {
        const target = event.target as TextArea;
        if (event.key==='Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            const value = target.control.value;
            const submitted = props.mode==='edit'
                ? editMessage(props.messageId ?? '', value)
                : sendMessage(value);
            if (!submitted) {
                return;
            }
            if (props.mode!=='edit') {
                target.control.value = '';
                autoExpand();
            }
            emit('submitted');
            return;
        }

        if (event.key==='Enter' && (event.ctrlKey || event.shiftKey || event.metaKey)) {
            event.preventDefault();
            target.control.value += '\n';
            autoExpand();
        }
    }
</script>

<template>
    <vscode-text-area
        ref="textAreaRef"
        @focus="setActive"
        @input="autoExpand"
        @keydown="handleKeybinding"
        autofocus
        resize="none"
        :placeholder="placeholder">
    </vscode-text-area>
</template>

<style scoped>
    vscode-text-area {
        width: 100%;
        margin-bottom: 10px;
    }
</style>
