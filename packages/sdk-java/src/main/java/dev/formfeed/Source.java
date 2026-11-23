package dev.formfeed;

/**
 * What a PDF tool or the e-invoice check works on: a {@link Render} (its output), a {@link
 * LibraryFile} of the workspace's library, or an {@link Upload}, which is sent with the request and
 * never stored. Every method that takes a source also takes its id as a string ({@code rnd_…},
 * {@code fil_…}, or a library file's name).
 */
public interface Source {}
