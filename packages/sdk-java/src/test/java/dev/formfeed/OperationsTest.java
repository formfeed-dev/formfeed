package dev.formfeed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The SDK's half of the operations table (plan 34, decision 9): {@code operations.json} names a
 * method for every operation of the API, or why there is none. {@code
 * packages/api-types/src/lib/sdk-fixtures.spec.ts} holds the names to the API; this holds them to
 * the client, so a renamed method fails here.
 */
final class OperationsTest {
  private static Map<String, Object> operations() {
    Object operations =
        ClientTestCase.json(ClientTestCase.packageDir().resolve("operations.json"))
            .get("operations");
    assertTrue(operations instanceof Map, "operations.json has operations");
    Map<String, Object> out = new TreeMap<>();
    ((Map<?, ?>) operations).forEach((id, value) -> out.put(String.valueOf(id), value));
    return out;
  }

  static Stream<Arguments> named() {
    return operations().entrySet().stream()
        .filter(entry -> entry.getValue() instanceof String)
        .map(entry -> Arguments.of(entry.getKey(), entry.getValue()));
  }

  @Test
  void theFirstReleaseNamesItsThirtyFourOperations() {
    assertEquals(34, named().count());
  }

  @ParameterizedTest(name = "{0}: {1}")
  @MethodSource("named")
  void theNamedMethodExists(String operation, String path) throws NoSuchMethodException {
    String[] parts = path.split("\\.");
    assertEquals(2, parts.length, operation + ": service.method");
    Method accessor = Formfeed.class.getMethod(parts[0]);
    assertTrue(Modifier.isPublic(accessor.getModifiers()), operation + ": " + parts[0] + "()");
    Class<?> service = accessor.getReturnType();
    assertTrue(
        Arrays.stream(service.getMethods())
            .anyMatch(method ->
                method.getName().equals(parts[1]) && method.getDeclaringClass() == service),
        operation + ": no method " + service.getSimpleName() + "." + parts[1]);
  }

  @Test
  void everyOperationWithoutAMethodSaysWhy() {
    operations()
        .forEach((id, value) -> {
          if (value instanceof String) {
            return;
          }
          assertTrue(value instanceof Map, id);
          Object reason = ((Map<?, ?>) value).get("none");
          assertTrue(reason instanceof String && !((String) reason).isBlank(), id);
          assertFalse(((String) reason).contains("Client::"), id + " names PHP's client");
        });
  }

  /**
   * The table of the API's operations travels with the shared vectors; outside them, nothing to
   * compare.
   */
  @Test
  void theMapNamesEveryOperationOfTheApi() {
    Path table = ClientTestCase.packageDir().resolve("../api-types/fixtures/sdk/operations.json");
    Assumptions.assumeTrue(Files.isRegularFile(table), "no operations table beside the package");
    Object api = ClientTestCase.json(table).get("operations");
    assertTrue(api instanceof Map);
    assertEquals(new TreeMap<>((Map<?, ?>) api).keySet(), operations().keySet());
  }
}
