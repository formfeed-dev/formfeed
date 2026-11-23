package dev.formfeed;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * The workspace's webhook endpoints. Needs {@code webhook:manage}. Verify a delivery with {@link
 * Webhook}.
 */
public final class Webhooks {
  private final Transport transport;

  Webhooks(Transport transport) {
    this.transport = transport;
  }

  public List<WebhookEndpoint> list() {
    List<WebhookEndpoint> out = new ArrayList<>();
    for (Map<String, Object> endpoint :
        Fields.objects(transport.object("GET", "/webhooks"), "data")) {
      out.add(WebhookEndpoint.fromMap(endpoint));
    }
    return Collections.unmodifiableList(out);
  }

  /**
   * Registers an endpoint; the answer carries its {@code secret}, once.
   *
   * @param input {@code url}, and {@code events}, {@code environments}, {@code description}
   */
  public WebhookEndpoint create(Map<String, ?> input) {
    return WebhookEndpoint.fromMap(transport.object("POST", "/webhooks", input, null));
  }

  /**
   * Changes an endpoint.
   *
   * @param patch {@code url}, {@code events}, {@code environments}, {@code description}, {@code
   *     enabled}
   */
  public WebhookEndpoint update(String id, Map<String, ?> patch) {
    return WebhookEndpoint.fromMap(
        transport.object("PUT", "/webhooks/" + Ids.segment(id), patch, null));
  }

  public void delete(String id) {
    transport.call("DELETE", "/webhooks/" + Ids.segment(id), null, null);
  }

  /**
   * Sends a test delivery to the endpoint.
   *
   * @return {@code queued}
   */
  public Map<String, Object> test(String id) {
    return transport.object("POST", "/webhooks/" + Ids.segment(id) + "/test");
  }

  /**
   * Sends a stored event ({@code evt_…}) again as a new delivery to an endpoint.
   *
   * @return the new delivery
   */
  public Map<String, Object> resend(String eventId, String endpointId) {
    return transport.object(
        "POST",
        "/webhooks/events/" + Ids.segment(eventId) + "/resend",
        Map.of("endpoint_id", endpointId),
        null);
  }
}
