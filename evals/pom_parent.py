"""Read the direct Maven parent using the standard-library XML parser."""

import json
import sys
import xml.etree.ElementTree as ET


def read_parent(filename):
    root = ET.parse(filename).getroot()
    namespace = root.tag.partition("}")[0] + "}" if root.tag.startswith("{") else ""
    if root.tag != namespace + "project":
        raise ValueError("Expected a Maven project element")
    parent = root.find(namespace + "parent")
    if parent is None:
        raise ValueError("No direct project parent found")
    result = {}
    for field in ("groupId", "artifactId", "version"):
        value = parent.findtext(namespace + field, "").strip()
        if not value:
            raise ValueError("Missing parent " + field)
        result[field] = value
    return result


if __name__ == "__main__":
    print(json.dumps(read_parent(sys.argv[1])))
