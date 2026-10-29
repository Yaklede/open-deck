package app.opendeck.client;

import java.util.Objects;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Keeps an open control current without turning programmatic updates into user edits. */
final class SettingsControlBinding {
  private final Supplier<Object> model;
  private final Consumer<Object> render;
  private Object displayed;
  private boolean initialized, editing, rendering;

  SettingsControlBinding(Supplier<Object> model, Consumer<Object> render) {
    this.model = model;
    this.render = render;
  }

  void refresh() {
    if (editing) return;
    Object value = model.get();
    if (initialized && Objects.equals(displayed, value)) return;
    rendering = true;
    try {
      render.accept(value);
      displayed = value;
      initialized = true;
    } finally {
      rendering = false;
    }
  }

  void beginEdit() {
    editing = true;
  }

  void endEdit() {
    editing = false;
    refresh();
  }

  boolean isEditing() {
    return editing;
  }

  void change(Object value, Consumer<Object> save) {
    if (rendering) return;
    displayed = value;
    initialized = true;
    save.accept(value);
    refresh();
  }
}
