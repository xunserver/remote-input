import {
  createRib32DecoderState,
  getRib32LineErrors,
  getRib32Tasks,
  ingestRib32Text,
} from "./base32Frame";
import type { Rib32DecoderState, Rib32TaskView } from "./base32Frame";

export type Rib32DecoderSnapshot = {
  tasks: Rib32TaskView[];
  lineErrors: string[];
  buffer: string;
};

export type Rib32DecoderUpdate = {
  snapshot: Rib32DecoderSnapshot;
  completedTasks: Rib32TaskView[];
};

export type Rib32InputDecoderOptions = {
  onUpdate?: (update: Rib32DecoderUpdate) => void;
  onComplete?: (task: Rib32TaskView) => void;
};

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

type Binding = {
  input: TextInputElement;
  listener: () => void;
};

export class RemoteInputDecoder {
  private state: Rib32DecoderState;
  private completedTaskIds: Set<number>;
  private bindings: Set<Binding>;
  private options: Rib32InputDecoderOptions;

  constructor(options: Rib32InputDecoderOptions = {}) {
    this.state = createRib32DecoderState();
    this.completedTaskIds = new Set();
    this.bindings = new Set();
    this.options = options;
  }

  ingest(text: string): Rib32DecoderUpdate {
    ingestRib32Text(this.state, text);
    return this.emitUpdate();
  }

  snapshot(): Rib32DecoderSnapshot {
    return {
      tasks: getRib32Tasks(this.state),
      lineErrors: getRib32LineErrors(this.state),
      buffer: this.state.buffer,
    };
  }

  reset(): Rib32DecoderUpdate {
    this.state = createRib32DecoderState();
    this.completedTaskIds.clear();
    return this.emitUpdate();
  }

  bindTextInput(input: TextInputElement): () => void {
    let processedLength = input.value.length;
    const listener = () => {
      const newText = input.value.slice(processedLength);
      const update = this.ingest(newText);
      input.value = update.snapshot.buffer;
      processedLength = input.value.length;
    };
    const binding = { input, listener };
    this.bindings.add(binding);
    input.addEventListener("input", listener);
    return () => {
      input.removeEventListener("input", listener);
      this.bindings.delete(binding);
    };
  }

  destroy(): void {
    for (const binding of this.bindings) {
      binding.input.removeEventListener("input", binding.listener);
    }
    this.bindings.clear();
  }

  private emitUpdate(): Rib32DecoderUpdate {
    const snapshot = this.snapshot();
    const completedTasks = snapshot.tasks.filter((task) => {
      if (task.status !== "complete" || this.completedTaskIds.has(task.taskId)) {
        return false;
      }
      this.completedTaskIds.add(task.taskId);
      return true;
    });
    const update = { snapshot, completedTasks };
    this.options.onUpdate?.(update);
    for (const task of completedTasks) {
      this.options.onComplete?.(task);
    }
    return update;
  }
}

export function createRib32InputDecoder(options: Rib32InputDecoderOptions = {}): RemoteInputDecoder {
  return new RemoteInputDecoder(options);
}
