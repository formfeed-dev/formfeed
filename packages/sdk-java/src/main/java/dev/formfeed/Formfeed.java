package dev.formfeed;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.function.DoubleSupplier;

/**
 * The Formfeed API.
 *
 * <pre>{@code
 * Formfeed formfeed = Formfeed.builder().apiKey(System.getenv("FORMFEED_API_KEY")).build();
 * Render render = formfeed.renders().create(RenderRequest.template("invoice").data(data));
 * formfeed.renders().downloadTo(render, Path.of("invoice.pdf"));
 * }</pre>
 *
 * <p>One client serves any number of threads: it holds no state between calls but its HTTP client's
 * connections. It retries 429 and 503 answers and network errors up to three times, waiting what
 * {@code Retry-After} says, sends an Idempotency-Key with every call that creates a render, and
 * turns every problem the API answers into a {@link FormfeedException}.
 */
public final class Formfeed {
  /** The release of this SDK, the same for every Formfeed package. */
  public static final String VERSION = "0.3.31";

  private static final Map<String, String> HOSTS =
      Map.of(
          "eu", "https://api-eu.formfeed.dev/v1",
          "us", "https://api-us.formfeed.dev/v1");

  private final Transport transport;
  private final Renders renders;
  private final Jobs jobs;
  private final Pdf pdf;
  private final Einvoices einvoices;
  private final Files files;
  private final Templates templates;
  private final Webhooks webhooks;
  private final Account account;

  private Formfeed(Transport transport) {
    this.transport = transport;
    this.renders = new Renders(transport);
    this.jobs = new Jobs(transport);
    this.pdf = new Pdf(transport);
    this.einvoices = new Einvoices(transport);
    this.files = new Files(transport);
    this.templates = new Templates(transport);
    this.webhooks = new Webhooks(transport);
    this.account = new Account(transport);
  }

  /** Starts a client; {@link Builder#apiKey(String)} is the one setting it needs. */
  public static Builder builder() {
    return new Builder();
  }

  /** Renders: create, get, list, wait for, download, batches. */
  public Renders renders() {
    return renders;
  }

  /** Jobs: batches and their ZIPs. */
  public Jobs jobs() {
    return jobs;
  }

  /**
   * The PDF tools: merge, protect, watermark, info, split, compress, toImage, redact, fill,
   * convert.
   */
  public Pdf pdf() {
    return pdf;
  }

  /** E-invoice validation. */
  public Einvoices einvoices() {
    return einvoices;
  }

  /** The workspace's file library. */
  public Files files() {
    return files;
  }

  /** The workspace's templates, read and checked. */
  public Templates templates() {
    return templates;
  }

  /** The workspace's webhook endpoints. */
  public Webhooks webhooks() {
    return webhooks;
  }

  /** The key's account and its usage. */
  public Account account() {
    return account;
  }

  /** {@link #request(String, String, Object, String)} without a body. */
  public Object request(String method, String path) {
    return request(method, path, null, null);
  }

  /** {@link #request(String, String, Object, String)} without an Idempotency-Key. */
  public Object request(String method, String path, Object body) {
    return request(method, path, body, null);
  }

  /**
   * Any call of the API with the client's key, retries and problems, for one without a method here
   * (template authoring, channels, shared partials, the brand kit).
   *
   * <pre>{@code
   * Map<?, ?> brand = (Map<?, ?>) formfeed.request("GET", "/brand");
   * }</pre>
   *
   * @param method {@code GET}, {@code POST}, {@code PUT}, {@code DELETE}, …
   * @param path the path after {@code /v1}, such as {@code /brand}
   * @param body sent as JSON: a map, a list or any object Jackson writes; null for none
   * @param idempotencyKey sent as {@code Idempotency-Key}; null for none
   * @return the decoded JSON answer (a map, a list, a string, a number or a boolean, read-only),
   *     null for none
   */
  public Object request(String method, String path, Object body, String idempotencyKey) {
    return transport.call(method, path, body, idempotencyKey);
  }

  String baseUrl() {
    return transport.baseUrl();
  }

  /** The client's settings. Every one but the API key has a default. */
  public static final class Builder {
    private String apiKey;
    private String region = "eu";
    private String baseUrl;
    private HttpClient httpClient;
    private int maxRetries = 3;
    private Duration timeout = Duration.ofSeconds(120);
    private final Map<String, String> headers = new LinkedHashMap<>();
    private Sleeper sleeper;
    private DoubleSupplier jitter;
    private ObjectMapper objectMapper;

    private Builder() {}

    /** The API key, {@code ff_live_…} or {@code ff_test_…}. */
    public Builder apiKey(String apiKey) {
      this.apiKey = apiKey;
      return this;
    }

    /** {@code eu} (the default) or {@code us}; ignored when a base URL is given. */
    public Builder region(String region) {
      this.region = region;
      return this;
    }

    /** The full base URL with {@code /v1}, for a local or another gateway. */
    public Builder baseUrl(String baseUrl) {
      this.baseUrl = baseUrl;
      return this;
    }

    /**
     * The HTTP client to send with, with your own proxy, executor or TLS settings. The SDK's own
     * follows redirects and gives up connecting after ten seconds.
     */
    public Builder httpClient(HttpClient httpClient) {
      this.httpClient = httpClient;
      return this;
    }

    /** Retries on 429, 503 and network errors; 3 by default, 0 turns them off. */
    public Builder maxRetries(int maxRetries) {
      this.maxRetries = Math.max(0, maxRetries);
      return this;
    }

    /** How long each request may take until its answer arrives; 120 seconds by default. */
    public Builder timeout(Duration timeout) {
      this.timeout = timeout;
      return this;
    }

    /** A header sent with every request, after the SDK's own, so it can replace one of them. */
    public Builder header(String name, String value) {
      this.headers.put(name, value);
      return this;
    }

    /** How to wait between retries and polls; the thread sleeps by default. */
    public Builder sleeper(Sleeper sleeper) {
      this.sleeper = sleeper;
      return this;
    }

    /**
     * Which share of the 250 ms of jitter a retry waits on top, a number from 0 to 1; random by
     * default. Tests pin it to see the lowest and the highest wait.
     */
    public Builder jitter(DoubleSupplier jitter) {
      this.jitter = jitter;
      return this;
    }

    /**
     * The Jackson mapper that writes request bodies and reads answers, such as Spring's, so that
     * the data of a render may hold your own objects with your modules (dates, say).
     */
    public Builder objectMapper(ObjectMapper objectMapper) {
      this.objectMapper = objectMapper;
      return this;
    }

    /**
     * The client.
     *
     * @throws FormfeedException {@code invalid_request} without an API key or with an unknown
     *     region
     */
    public Formfeed build() {
      if (apiKey == null || apiKey.isEmpty()) {
        throw new FormfeedException("invalid_request", "apiKey is required");
      }
      String host = baseUrl != null ? baseUrl : HOSTS.get(region);
      if (host == null) {
        throw new FormfeedException(
            "invalid_request", "unknown region " + region + ": eu or us, or a baseUrl");
      }
      while (host.endsWith("/")) {
        host = host.substring(0, host.length() - 1);
      }
      Duration limit = timeout == null ? Duration.ofSeconds(120) : timeout;
      HttpClient http =
          httpClient != null
              ? httpClient
              : HttpClient.newBuilder()
                  .connectTimeout(
                      limit.compareTo(Duration.ofSeconds(10)) < 0 ? limit : Duration.ofSeconds(10))
                  .followRedirects(HttpClient.Redirect.NORMAL)
                  .build();
      Sleeper wait =
          sleeper != null ? sleeper : duration -> TimeUnit.NANOSECONDS.sleep(duration.toNanos());
      DoubleSupplier share =
          jitter != null ? jitter : () -> ThreadLocalRandom.current().nextDouble();
      Json json = objectMapper != null ? new Json(objectMapper) : Json.DEFAULT;
      return new Formfeed(
          new Transport(
              apiKey,
              host,
              http,
              limit,
              maxRetries,
              Collections.unmodifiableMap(new LinkedHashMap<>(headers)),
              wait,
              share,
              json));
    }
  }
}
