import Foundation
import Testing
import WebKit
@testable import Knock

/// HAIL-141: the .svg sanitising rules, the offline generated wrapper page,
/// and the bundled Mermaid build.
struct DiagramSVGSanitizerTests {
    @Test func stripsScriptElements() {
        let input = #"<svg><script>alert("x")</script><rect/></svg>"#
        let output = DiagramSVGSanitizer.sanitize(input)
        #expect(!output.contains("<script"))
        #expect(!output.contains("alert("))
    }

    @Test func stripsScriptCaseInsensitively() {
        let input = #"<svg><SCRIPT type="text/javascript">x</SCRIPT></svg>"#
        let output = DiagramSVGSanitizer.sanitize(input)
        #expect(!output.lowercased().contains("<script"))
    }

    @Test func stripsEventHandlerAttributes() {
        let input = #"<svg><rect onclick="go()" onload='run()'/></svg>"#
        let output = DiagramSVGSanitizer.sanitize(input)
        #expect(!output.contains("onclick"))
        #expect(!output.contains("onload"))
    }

    @Test func stripsForeignObject() {
        let input = #"<svg><foreignObject><div>html</div></foreignObject><rect/></svg>"#
        let output = DiagramSVGSanitizer.sanitize(input)
        #expect(!output.lowercased().contains("foreignobject"))
        #expect(!output.contains("<div>"))
    }

    @Test func stripsExternalHrefsAndKeepsFragments() {
        let input = "<svg><a href=\"https://evil.example\"><use href=\"#a\"/><image xlink:href=\"http://x\"/></a></svg>"
        let output = DiagramSVGSanitizer.sanitize(input)
        #expect(!output.contains("https://evil.example"))
        #expect(!output.contains("http://x"))
        #expect(output.contains("href=\"#a\""))
    }
}

struct DiagramPageTests {
    @Test func mermaidWrapperHasNoNetworkURLs() {
        let html = DiagramPage.wrapperHTML(source: "flowchart TD\n  A --> B", format: .mermaid)
        #expect(!html.contains("http://"))
        #expect(!html.contains("https://"))
        #expect(!html.contains("//cdn"))
        #expect(html.contains("mermaid.min.js"))
        #expect(html.contains(DiagramPage.titleSentinel))
        #expect(html.contains("Waggle could not draw this diagram"))
    }

    @Test func svgWrapperInlinesTheSanitisedSVGAndHasNoNetworkFetches() {
        let source = "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"x()\"><rect width=\"10\" height=\"10\"/></svg>"
        let html = DiagramPage.wrapperHTML(source: source, format: .svg)
        #expect(html.contains("<rect"))
        #expect(!html.contains("onload"))
        #expect(!html.contains("src=\"http"))
        #expect(!html.contains("href=\"http"))
        #expect(!html.contains("xlink:href=\"http"))
    }

    @Test func jsStringEscapesScriptClose() {
        let escaped = DiagramPage.jsString("a </script> b")
        #expect(!escaped.contains("</script>"))
        #expect(escaped.contains("<\\/script>"))
    }

    @Test func svgWrapperDerivesAViewBoxWhenOnlyWidthAndHeight() {
        let source = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"520\" height=\"180\"><rect width=\"10\" height=\"10\"/></svg>"
        let derived = DiagramPage.deriveViewBoxIfMissing(in: source)
        #expect(derived.contains("viewBox=\"0 0 520 180\""))
    }

    @Test func svgWrapperKeepsAnExistingViewBox() {
        let source = "<svg viewBox=\"0 0 10 10\" width=\"520\" height=\"180\"><rect width=\"10\" height=\"10\"/></svg>"
        let derived = DiagramPage.deriveViewBoxIfMissing(in: source)
        #expect(derived.contains("viewBox=\"0 0 10 10\""))
        #expect(!derived.contains("viewBox=\"0 0 520 180\""))
    }

    @Test func svgWrapperDoesNotDeriveAViewBoxFromUnitValuedDimensions() {
        let source = "<svg width=\"100%\" height=\"100%\"><rect width=\"10\" height=\"10\"/></svg>"
        let derived = DiagramPage.deriveViewBoxIfMissing(in: source)
        #expect(!derived.contains("viewBox="))
    }

    @Test func wrappersUseTheLightViewerBackgroundAndNoPagePadding() {
        let svg = DiagramPage.wrapperHTML(source: "<svg width=\"10\" height=\"10\"/>", format: .svg)
        let mmd = DiagramPage.wrapperHTML(source: "flowchart TD\n  A --> B", format: .mermaid)
        for html in [svg, mmd] {
            #expect(html.contains(DiagramPage.pageBackgroundHex))
            #expect(!html.contains("padding: 24px"))
            #expect(!html.contains("max-width: 100%"))
        }
    }

    @Test func mermaidWrapperDrawsTheSvgAtItsNaturalSize() {
        let html = DiagramPage.wrapperHTML(source: "flowchart TD\n  A --> B", format: .mermaid)
        // Mermaid's responsive max-width cap is removed so 100% shows natural
        // size and Fit can scale the produced SVG up.
        #expect(html.contains("maxWidth = \"none\""))
        #expect(html.contains("setAttribute(\"width\""))
    }
}

/// Guards HAIL-141's "Mermaid build bundled in the app resources" acceptance:
/// the resource ships in Knock_Knock.bundle with its MIT license beside it,
/// and it is the real minified build, not a stub.
struct MermaidResourceTests {
    @Test func mermaidBuildAndLicenseAreBundled() throws {
        let url = try #require(MermaidResource.mermaidJSURL())
        #expect(url.lastPathComponent == "mermaid.min.js")

        let license = url.deletingLastPathComponent().appendingPathComponent("LICENSE.txt")
        #expect(FileManager.default.fileExists(atPath: license.path))

        let data = try Data(contentsOf: url)
        #expect(data.count > 100_000)
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("mermaid"))
    }
}

/// Renders the real Mermaid wrapper in an isolated `WKWebView` (the same
/// configuration the app uses) and checks it draws a flowchart, not the error
/// state. This caught the `mermaid.render` result being an object (`{ svg }`)
/// rather than a string - a string-only wrapper test cannot see that.
struct DiagramRenderTests {
    @MainActor
    @Test func mermaidWrapperRendersAFlowchart() async throws {
        let mermaid = try #require(MermaidResource.mermaidJSURL())
        let source = "flowchart TD\n    A[Open ask] --> B[Build]\n    B --> C[Ship]"
        let directory = try DiagramPage.makeTempDirectory()
        let entry = try DiagramPage.materialize(
            source: source, format: .mermaid, mermaidJSURL: mermaid, into: directory
        )

        let contentRuleList = try await HTMLIsolation.compiledContentRuleList()
        let configuration = HTMLIsolation.makeConfiguration(contentRuleList: contentRuleList)
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        HTMLIsolation.load(entry: entry, directory: directory, into: webView)

        let deadline = Date().addingTimeInterval(20)
        while webView.title != DiagramPage.titleSentinel && Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(webView.title == DiagramPage.titleSentinel)

        let html = (try? await webView.evaluateJavaScript("document.getElementById('diagram').innerHTML") as? String) ?? ""
        #expect(html.contains("<svg"))
        #expect(html.contains("Open ask"))
        #expect(html.contains("Ship"))
        #expect(!html.contains("could not draw"))
    }

    @MainActor
    @Test func svgWrapperRendersInTheIsolatedViewer() async throws {
        let source = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 520 180\" width=\"520\" height=\"180\"><rect x=\"10\" y=\"60\" width=\"90\" height=\"44\" rx=\"8\" fill=\"#2f6fed\" /><text x=\"55\" y=\"88\" text-anchor=\"middle\" fill=\"#fff\" font-size=\"13\">Ask</text></svg>"
        let directory = try DiagramPage.makeTempDirectory()
        let entry = try DiagramPage.materialize(source: source, format: .svg, mermaidJSURL: nil, into: directory)

        let contentRuleList = try await HTMLIsolation.compiledContentRuleList()
        let configuration = HTMLIsolation.makeConfiguration(contentRuleList: contentRuleList)
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        HTMLIsolation.load(entry: entry, directory: directory, into: webView)

        let deadline = Date().addingTimeInterval(20)
        while webView.title != DiagramPage.titleSentinel && Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(webView.title == DiagramPage.titleSentinel)

        let size = (try? await webView.evaluateJavaScript(
            "document.querySelector('rect')?.getBoundingClientRect().width + 'x' + document.querySelector('rect')?.getBoundingClientRect().height"
        ) as? String) ?? ""
        #expect(size == "90x44")

        // The fill must survive a snapshot too: the evidence window shot reads
        // the web view through takeSnapshot, not the DOM.
        let snapshot = try await webView.takeSnapshot(configuration: WKSnapshotConfiguration())
        guard let tiff = snapshot.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else {
            Issue.record("takeSnapshot returned no image")
            return
        }
        var nonWhite = 0
        for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 2) {
                guard let c = rep.colorAt(x: x, y: y) else { continue }
                if c.redComponent < 0.9 || c.greenComponent < 0.9 || c.blueComponent < 0.9 { nonWhite += 1 }
            }
        }
        #expect(nonWhite > 50)
    }
}
