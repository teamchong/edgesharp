const std = @import("std");

pub fn build(b: *std.Build) void {
    // === Native tests ===
    const native_target = b.standardTargetOptions(.{});
    const native_optimize = b.standardOptimizeOption(.{});

    const test_step = b.step("test", "Run unit tests");
    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = native_target,
            .optimize = native_optimize,
        }),
    });
    // Link miniz for native tests too
    unit_tests.root_module.addCSourceFiles(.{
        .files = &.{"src/miniz.c"},
        .flags = &.{ "-DMINIZ_NO_STDIO", "-DMINIZ_NO_TIME", "-DMINIZ_NO_ARCHIVE_APIS", "-DMINIZ_NO_ARCHIVE_WRITING_APIS" },
    });
    unit_tests.root_module.addIncludePath(b.path("src"));
    test_step.dependOn(&b.addRunArtifact(unit_tests).step);

    // === WASM Build ===
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_features_add = std.Target.wasm.featureSet(&.{
            .simd128,
            .relaxed_simd,
            .bulk_memory,
            .sign_ext,
        }),
    });

    const wasm_mod = b.createModule(.{
        .root_source_file = b.path("src/wasm.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
        .strip = true,
        .unwind_tables = .none,
    });

    // Statically link miniz (deflate compression) for WASM
    wasm_mod.addCSourceFiles(.{
        .files = &.{"src/miniz.c"},
        .flags = &.{
            "-DMINIZ_NO_STDIO",
            "-DMINIZ_NO_TIME",
            "-DMINIZ_NO_ARCHIVE_APIS",
            "-DMINIZ_NO_ARCHIVE_WRITING_APIS",
            "-DMINIZ_NO_ZLIB_COMPATIBLE_NAMES",
            "-fno-stack-protector",
            "-O2",
        },
    });
    wasm_mod.addIncludePath(b.path("src"));

    const wasm = b.addExecutable(.{
        .name = "edgesharp",
        .root_module = wasm_mod,
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;

    const wasm_step = b.step("wasm", "Build WASM module");
    const install_wasm = b.addInstallArtifact(wasm, .{});
    wasm_step.dependOn(&install_wasm.step);
}
