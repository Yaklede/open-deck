package app.opendeck.client;

import java.io.IOException;
import java.io.Reader;
import java.io.StringReader;
import java.net.SocketTimeoutException;
import java.util.concurrent.atomic.AtomicLong;

public final class SseLineReaderTest {
  private static int checks;

  private static void check(boolean condition, String description) {
    checks++;
    if (!condition) throw new AssertionError(description);
  }

  private interface ReadAction {
    void run() throws IOException;
  }

  private static void throwsType(
      Class<? extends Exception> type, ReadAction action, String description) {
    checks++;
    try {
      action.run();
      throw new AssertionError(description + ": no exception");
    } catch (IOException e) {
      if (!type.isInstance(e)) throw new AssertionError(description + ": " + e);
    }
  }

  public static void main(String[] args) throws Exception {
    try (SseLineReader reader =
        new SseLineReader(
            new StringReader("data: one\n\n: ping\r\ndata:two\rthird\r\nlast"), 100, () -> 0)) {
      check("data: one".equals(reader.readLine(0)), "LF line is returned without delimiter");
      check("".equals(reader.readLine(0)), "Empty SSE frame boundary is preserved");
      check(": ping".equals(reader.readLine(0)), "CRLF heartbeat line is preserved");
      check("data:two".equals(reader.readLine(0)), "Standalone CR ends a line");
      check("third".equals(reader.readLine(0)), "CRLF consumes exactly one LF");
      check("last".equals(reader.readLine(0)), "Partial line at EOF is returned");
      check(reader.readLine(0) == null, "EOF with no content is null");
      check(reader.readLine(0) == null, "Repeated EOF remains null");
    }
    for (String ending : new String[] {"\n", "\r", "\r\n"}) {
      try (SseLineReader reader = new SseLineReader(new StringReader("a" + ending), 1, () -> 0)) {
        check("a".equals(reader.readLine(0)), "Exact length before newline is allowed");
        check(reader.readLine(0) == null, "Trailing delimiter does not fabricate another line");
      }
    }
    try (SseLineReader reader = new SseLineReader(new StringReader("\r\r\n\n"), 1, () -> 0)) {
      check("".equals(reader.readLine(0)), "First empty CR line");
      check("".equals(reader.readLine(0)), "Second empty CRLF line");
      check("".equals(reader.readLine(0)), "Following LF remains a distinct empty line");
      check(reader.readLine(0) == null, "All empty lines exhausted");
    }
    try (SseLineReader reader = new SseLineReader(new StringReader("12345"), 5, () -> 0)) {
      check("12345".equals(reader.readLine(0)), "Exact max length at EOF is allowed");
    }
    try (SseLineReader reader = new SseLineReader(new StringReader("123456\n"), 5, () -> 0)) {
      throwsType(IOException.class, () -> reader.readLine(0), "Oversized line is rejected");
    }
    String large = "x".repeat(4 * 1024 * 1024);
    try (SseLineReader reader =
        new SseLineReader(new StringReader(large + "\n"), large.length(), () -> 0)) {
      check(
          reader.readLine(0).length() == large.length(),
          "Configured 4Mi-character boundary succeeds");
    }
    try (SseLineReader reader =
        new SseLineReader(new StringReader(large + "x\n"), large.length(), () -> 0)) {
      throwsType(
          IOException.class,
          () -> reader.readLine(0),
          "Configured large boundary cannot be exceeded");
    }
    check(
        "{\"state\":{}}".equals(SseLineReader.dataPayload("data: {\"state\":{}}")),
        "Standard data prefix");
    check(
        "{\"state\":{}}".equals(SseLineReader.dataPayload("data:{\"state\":{}}")),
        "No-space data prefix");
    check(
        " value".equals(SseLineReader.dataPayload("data:  value")),
        "Only one optional space is removed");
    check(
        "\tvalue".equals(SseLineReader.dataPayload("data:\tvalue")),
        "Other whitespace is preserved");
    check(
        "".equals(SseLineReader.dataPayload("data:")),
        "Empty data payload is distinguishable from heartbeat");
    check(
        "".equals(SseLineReader.dataPayload("data: ")), "Optional space can precede empty payload");
    for (String nonData :
        new String[] {
          "", ": heartbeat", "event: ping", "retry: 1000", " data: x", "Data: x", "data"
        })
      check(SseLineReader.dataPayload(nonData) == null, "Non-data line stays non-data: " + nonData);
    check(SseLineReader.dataPayload(null) == null, "Null line has no payload");

    AtomicLong now = new AtomicLong(1000);
    try (SseLineReader reader = new SseLineReader(new StringReader("a\nb\n"), 100, now::get)) {
      check("a".equals(reader.readLine(1001)), "Read immediately before deadline succeeds");
      now.set(1001);
      throwsType(
          SocketTimeoutException.class,
          () -> reader.readLine(1001),
          "Exact deadline rejects even buffered input");
      check("b".equals(reader.readLine(0)), "Deadline zero removes clock constraint");
    }
    AtomicLong reads = new AtomicLong();
    Reader slow =
        new Reader() {
          public int read(char[] buffer, int offset, int length) {
            reads.incrementAndGet();
            now.set(5000);
            buffer[offset] = 'a';
            return 1;
          }

          public void close() {}
        };
    now.set(1000);
    try (SseLineReader reader = new SseLineReader(slow, 100, now::get)) {
      throwsType(
          SocketTimeoutException.class,
          () -> reader.readLine(5000),
          "Deadline checked after a blocking read");
      check(reads.get() == 1, "Timed-out read does not consume another character");
    }
    now.set(0);
    try (SseLineReader reader =
        new SseLineReader(new StringReader("x".repeat(8192) + "\n"), 9000, now::getAndIncrement)) {
      throwsType(
          SocketTimeoutException.class,
          () -> reader.readLine(5),
          "Processing multiple buffered chunks cannot bypass the deadline");
    }
    try (SseLineReader reader =
        new SseLineReader(new StringReader("x".repeat(4095) + "\r\ndata: next\n"), 5000, () -> 0)) {
      check(reader.readLine(0).length() == 4095, "CR at chunk edge ends the line");
      check(
          "data: next".equals(reader.readLine(0)),
          "LF in next chunk is skipped without losing data");
      check(reader.readLine(0) == null, "Chunk boundary preserves EOF");
    }
    AtomicLong clockCalls = new AtomicLong();
    try (SseLineReader reader =
        new SseLineReader(
            new StringReader(large + "\n"),
            large.length(),
            () -> {
              clockCalls.incrementAndGet();
              return 1;
            })) {
      reader.readLine(10000);
      check(
          clockCalls.get() < 4000,
          "Large bounded read checks the clock per chunk, not per character");
    }
    try (SseLineReader reader = new SseLineReader(new StringReader(""), 100, () -> 20)) {
      throwsType(
          SocketTimeoutException.class,
          () -> reader.readLine(20),
          "Expired deadline is not disguised as EOF");
    }
    AtomicLong closes = new AtomicLong();
    Reader tracked =
        new StringReader("a") {
          @Override
          public void close() {
            closes.incrementAndGet();
            super.close();
          }
        };
    try (SseLineReader ignored = new SseLineReader(tracked, 10, () -> 0)) {}
    check(closes.get() == 1, "Closing wrapper closes underlying reader");
    checks++;
    try {
      new SseLineReader(new StringReader(""), 0, () -> 0);
      throw new AssertionError("Nonpositive line limit accepted");
    } catch (IllegalArgumentException expected) {
    }
    System.out.println("SseLineReader: " + checks + " checks passed");
  }
}
