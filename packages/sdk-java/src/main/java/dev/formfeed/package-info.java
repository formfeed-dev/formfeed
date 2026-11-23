/**
 * The Java SDK of <a href="https://formfeed.dev">Formfeed</a>: PDFs and images from templates,
 * HTML, URLs or Markdown, and tools for existing PDFs.
 *
 * <pre>{@code
 * Formfeed formfeed = Formfeed.builder().apiKey(System.getenv("FORMFEED_API_KEY")).build();
 *
 * Render render = formfeed.renders().create(
 *     RenderRequest.template("invoice").data(Map.of("customer", Map.of("name", "Olvarest GmbH"))));
 * formfeed.renders().downloadTo(render, Path.of("invoice.pdf"));
 * }</pre>
 *
 * <p>{@link dev.formfeed.Formfeed} is the client, with one accessor per part of the API; {@link
 * dev.formfeed.FormfeedException} is every error it raises; {@link dev.formfeed.Webhook} checks a
 * delivery's signature. The <a href="https://docs.formfeed.dev">documentation</a> describes every
 * call.
 */
package dev.formfeed;
