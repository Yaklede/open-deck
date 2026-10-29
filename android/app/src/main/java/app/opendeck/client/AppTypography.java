package app.opendeck.client;

import android.app.AlertDialog;
import android.content.Context;
import android.database.DataSetObserver;
import android.graphics.Typeface;
import android.util.SparseBooleanArray;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;

/** Bundled typography for native controls, including lazy dialog and dropdown rows. */
final class AppTypography {
  private static Typeface body, bold;

  static synchronized Typeface body(Context context) {
    if (body == null)
      body =
          new Typeface.Builder(context.getAssets(), "NotoSansKR.ttf")
              .setWeight(500)
              .setFontVariationSettings("'wght' 500")
              .build();
    return body;
  }

  static synchronized Typeface bold(Context context) {
    if (bold == null)
      bold =
          new Typeface.Builder(context.getAssets(), "NotoSansKR.ttf")
              .setWeight(700)
              .setFontVariationSettings("'wght' 700")
              .build();
    return bold;
  }

  static void apply(View view) {
    if (view instanceof TextView text) {
      Typeface previous = text.getTypeface();
      Typeface fixed =
          previous != null && previous.isBold() ? bold(view.getContext()) : body(view.getContext());
      text.setTypeface(fixed);
      if (text instanceof Switch toggle) toggle.setSwitchTypeface(fixed);
    }
    if (view instanceof ViewGroup group)
      for (int i = 0; i < group.getChildCount(); i++) apply(group.getChildAt(i));
  }

  static AlertDialog show(AlertDialog dialog) {
    dialog.show();
    apply(dialog);
    return dialog;
  }

  static void apply(AlertDialog dialog) {
    ListView list = dialog.getListView();
    if (list != null
        && list.getAdapter() != null
        && !(list.getAdapter() instanceof FontListAdapter)) {
      SparseBooleanArray checked = list.getCheckedItemPositions();
      checked = checked == null ? null : checked.clone();
      list.setAdapter(new FontListAdapter(list.getAdapter()));
      if (checked != null)
        for (int i = 0; i < checked.size(); i++)
          list.setItemChecked(checked.keyAt(i), checked.valueAt(i));
    }
    if (dialog.getWindow() != null) {
      View root = dialog.getWindow().getDecorView();
      apply(root);
      root.post(
          () -> {
            if (!dialog.isShowing()) return;
            apply(root);
            int[] counts = audit(root);
            android.util.Log.d(
                "OpenDeckFont", "NotoSansKR textViews=" + counts[0] + " mismatches=" + counts[1]);
          });
    }
  }

  static void validationMessage(AlertDialog dialog, String message) {
    TextView text = dialog.findViewById(android.R.id.message);
    if (text != null) {
      text.setText(message);
      text.setTypeface(body(text.getContext()));
    }
  }

  private static int[] audit(View view) {
    int count = 0, mismatches = 0;
    if (view instanceof TextView text) {
      count++;
      Typeface current = text.getTypeface();
      if (!body(view.getContext()).equals(current) && !bold(view.getContext()).equals(current))
        mismatches++;
    }
    if (view instanceof ViewGroup group)
      for (int i = 0; i < group.getChildCount(); i++) {
        int[] child = audit(group.getChildAt(i));
        count += child[0];
        mismatches += child[1];
      }
    return new int[] {count, mismatches};
  }

  static ArrayAdapter<String> choices(Context context, int layout, String[] values) {
    return new ArrayAdapter<String>(context, layout, values) {
      @Override
      public View getView(int position, View convert, ViewGroup parent) {
        View row = super.getView(position, convert, parent);
        apply(row);
        return row;
      }

      @Override
      public View getDropDownView(int position, View convert, ViewGroup parent) {
        View row = super.getDropDownView(position, convert, parent);
        apply(row);
        android.util.Log.d("OpenDeckFont", "NotoSansKR dropdown-row");
        return row;
      }
    };
  }

  private static final class FontListAdapter extends BaseAdapter implements WrapperListAdapter {
    private final ListAdapter delegate;
    private boolean reported;

    FontListAdapter(ListAdapter delegate) {
      this.delegate = delegate;
      delegate.registerDataSetObserver(
          new DataSetObserver() {
            @Override
            public void onChanged() {
              notifyDataSetChanged();
            }

            @Override
            public void onInvalidated() {
              notifyDataSetInvalidated();
            }
          });
    }

    public ListAdapter getWrappedAdapter() {
      return delegate;
    }

    public int getCount() {
      return delegate.getCount();
    }

    public Object getItem(int position) {
      return delegate.getItem(position);
    }

    public long getItemId(int position) {
      return delegate.getItemId(position);
    }

    public boolean hasStableIds() {
      return delegate.hasStableIds();
    }

    public int getItemViewType(int position) {
      return delegate.getItemViewType(position);
    }

    public int getViewTypeCount() {
      return delegate.getViewTypeCount();
    }

    public boolean areAllItemsEnabled() {
      return delegate.areAllItemsEnabled();
    }

    public boolean isEnabled(int position) {
      return delegate.isEnabled(position);
    }

    public View getView(int position, View convert, ViewGroup parent) {
      View row = delegate.getView(position, convert, parent);
      apply(row);
      if (!reported) {
        reported = true;
        android.util.Log.d("OpenDeckFont", "NotoSansKR list-row mismatches=" + audit(row)[1]);
      }
      return row;
    }
  }
}
