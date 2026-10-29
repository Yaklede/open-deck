#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_javac="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
task_java="${JAVA_HOME:+$JAVA_HOME/bin/}java"
task_classes="$(mktemp -d)"
trap 'rm -r -- "$task_classes"' EXIT
"$task_javac" -d "$task_classes" \
  android/app/src/main/java/app/opendeck/client/HostRecoveryPolicy.java \
  android/app/src/main/java/app/opendeck/client/StreamConnectionPolicy.java \
  android/app/src/main/java/app/opendeck/client/SseLineReader.java \
  android/app/src/main/java/app/opendeck/client/DataFreshness.java \
  test/android/HostRecoveryPolicyTest.java \
  test/android/StreamConnectionPolicyTest.java \
  test/android/SseLineReaderTest.java \
  test/android/DataFreshnessTest.java
"$task_java" -cp "$task_classes" app.opendeck.client.HostRecoveryPolicyTest
"$task_java" -cp "$task_classes" app.opendeck.client.StreamConnectionPolicyTest
"$task_java" -cp "$task_classes" app.opendeck.client.SseLineReaderTest
"$task_java" -cp "$task_classes" app.opendeck.client.DataFreshnessTest
