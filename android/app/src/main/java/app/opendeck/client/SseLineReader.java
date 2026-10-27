package app.opendeck.client;

import java.io.Closeable;
import java.io.IOException;
import java.io.Reader;
import java.net.SocketTimeoutException;
import java.util.Objects;
import java.util.function.LongSupplier;

/** Buffered SSE line reads with a length limit and an optional monotonic deadline. */
public final class SseLineReader implements Closeable {
  private final Reader reader;
  private final char[] buffer = new char[4096];
  private int position, available;
  private final int maxChars;
  private final LongSupplier now;
  private boolean skipLf;

  public SseLineReader(Reader reader, int maxChars, LongSupplier now) {
    Objects.requireNonNull(reader, "reader");
    if (maxChars <= 0) throw new IllegalArgumentException("maxChars must be positive");
    this.reader = reader;
    this.maxChars = maxChars;
    this.now = Objects.requireNonNull(now, "now");
  }

  public String readLine(long deadlineMs) throws IOException {
    StringBuilder line = new StringBuilder(Math.min(maxChars, 256));
    while (true) {
      checkDeadline(deadlineMs);
      if (position >= available) {
        available = reader.read(buffer, 0, buffer.length);
        position = 0;
        checkDeadline(deadlineMs);
        if (available < 0) return finish(line, deadlineMs, true);
        if (available == 0) continue;
      }
      if (skipLf) {
        skipLf = false;
        if (buffer[position] == '\n') {
          position++;
          if (position >= available) continue;
        }
      }
      int start = position;
      while (position < available && buffer[position] != '\r' && buffer[position] != '\n')
        position++;
      int length = position - start;
      if (length > maxChars - line.length()) throw new IOException("SSE line exceeds limit");
      line.append(buffer, start, length);
      checkDeadline(deadlineMs);
      if (position < available) {
        skipLf = buffer[position++] == '\r';
        return finish(line, deadlineMs, false);
      }
    }
  }

  private String finish(StringBuilder line, long deadlineMs, boolean eof) throws IOException {
    String result = eof && line.length() == 0 ? null : line.toString();
    checkDeadline(deadlineMs);
    return result;
  }

  private void checkDeadline(long deadlineMs) throws SocketTimeoutException {
    if (deadlineMs > 0 && now.getAsLong() >= deadlineMs)
      throw new SocketTimeoutException("SSE read deadline exceeded");
  }

  public static String dataPayload(String line) {
    if (line == null || !line.startsWith("data:")) return null;
    String value = line.substring(5);
    return value.startsWith(" ") ? value.substring(1) : value;
  }

  @Override
  public void close() throws IOException {
    reader.close();
  }
}
